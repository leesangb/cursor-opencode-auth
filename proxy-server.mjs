#!/usr/bin/env node
/**
 * Cursor API Proxy Server
 * Translates OpenAI-compatible requests to Cursor's Connect-RPC protobuf format
 * 
 * Usage: node proxy-server.mjs [port]
 * Then configure OpenCode to use http://localhost:PORT/v1 as the base URL
 */

import http from "http";
import http2 from "http2";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import zlib from "zlib";

const PORT = parseInt(process.argv[2]) || 4141;
const AGENT_BASE = "agentn.api5.cursor.sh";
const CLIENT_VERSION = "cli-2026.01.09-231024f";

// Get token from keychain
function getToken() {
  try {
    return execSync('security find-generic-password -s "cursor-access-token" -w', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("Error: Could not get token from keychain");
    process.exit(1);
  }
}

// Protobuf writer for manual encoding
class ProtoWriter {
  constructor() { this.parts = []; }
  
  writeVarint(v) {
    const b = [];
    while (v > 127) { b.push((v & 0x7f) | 0x80); v >>>= 7; }
    b.push(v & 0x7f);
    this.parts.push(Buffer.from(b));
  }
  
  writeString(field, value) {
    const buf = Buffer.from(value, 'utf8');
    this.writeVarint((field << 3) | 2);
    this.writeVarint(buf.length);
    this.parts.push(buf);
  }
  
  writeMessage(field, writer) {
    const buf = writer.toBuffer();
    this.writeVarint((field << 3) | 2);
    this.writeVarint(buf.length);
    this.parts.push(buf);
  }
  
  writeInt32(field, value) {
    this.writeVarint((field << 3) | 0);
    this.writeVarint(value);
  }
  
  toBuffer() { return Buffer.concat(this.parts); }
}

/**
 * Build protobuf request for Cursor's AgentService/Run
 */
function buildProtobufRequest(text, model = 'composer-1', context = '') {
  const messageId = randomUUID();
  const conversationId = randomUUID();

  // UserMessage
  const userMsg = new ProtoWriter();
  userMsg.writeString(1, text);
  userMsg.writeString(2, messageId);
  userMsg.writeString(3, '');

  // FileContext (minimal context)
  const fileCtx = new ProtoWriter();
  fileCtx.writeString(1, '/context.txt');
  fileCtx.writeString(2, context || 'OpenCode session');

  // ExplicitContext
  const explicitCtx = new ProtoWriter();
  explicitCtx.writeMessage(2, fileCtx);

  // UserMessageAction (field1 = UserMessage, field2 = ExplicitContext)
  const userMsgAction = new ProtoWriter();
  userMsgAction.writeMessage(1, userMsg);
  userMsgAction.writeMessage(2, explicitCtx);

  // ConversationAction
  const convAction = new ProtoWriter();
  convAction.writeMessage(1, userMsgAction);

  // ModelDetails
  const displayName = model.charAt(0).toUpperCase() + model.slice(1).replace(/-/g, ' ');
  const modelDetails = new ProtoWriter();
  modelDetails.writeString(1, model);
  modelDetails.writeString(3, model);
  modelDetails.writeString(4, displayName);
  modelDetails.writeString(5, displayName);
  modelDetails.writeInt32(7, 0);

  // AgentRunRequest
  const runReq = new ProtoWriter();
  runReq.writeString(1, '');  // Empty ConversationState
  runReq.writeMessage(2, convAction);
  runReq.writeMessage(3, modelDetails);
  runReq.writeString(4, '');
  runReq.writeString(5, conversationId);

  // AgentClientMessage
  const clientMsg = new ProtoWriter();
  clientMsg.writeMessage(1, runReq);

  return { payload: clientMsg.toBuffer(), messageId, conversationId };
}

// Create Connect-RPC frame
function createFrame(payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;  // Not compressed
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/**
 * Read a varint from buffer at position, return [value, newPos]
 */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Recursively extract all strings from a protobuf message
 * Returns array of {text, fieldPath, depth}
 */
function extractStringsFromProtobuf(buf, fieldPath = '', depth = 0) {
  const strings = [];
  let pos = 0;
  
  while (pos < buf.length) {
    // Read tag
    const [tag, newPos] = readVarint(buf, pos);
    if (newPos === pos) break; // Failed to read
    pos = newPos;
    
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    const currentPath = fieldPath ? `${fieldPath}.${fieldNum}` : `${fieldNum}`;
    
    if (wireType === 0) {
      // Varint - skip
      const [, nextPos] = readVarint(buf, pos);
      pos = nextPos;
    } else if (wireType === 1) {
      // 64-bit fixed - skip 8 bytes
      pos += 8;
    } else if (wireType === 2) {
      // Length-delimited (string, bytes, or embedded message)
      const [len, dataStart] = readVarint(buf, pos);
      pos = dataStart + len;
      
      if (len > 0 && dataStart + len <= buf.length) {
        const data = buf.slice(dataStart, dataStart + len);
        
        // Try to parse as embedded message first
        const nested = extractStringsFromProtobuf(data, currentPath, depth + 1);
        if (nested.length > 0) {
          strings.push(...nested);
        }
        
        // Also try as string if it looks printable
        const str = data.toString('utf8');
        if (str.length > 0 && /^[\x20-\x7e\n\r\t]+$/.test(str)) {
          strings.push({ text: str, fieldPath: currentPath, depth });
        }
      }
    } else if (wireType === 5) {
      // 32-bit fixed - skip 4 bytes
      pos += 4;
    } else {
      // Unknown wire type - bail
      break;
    }
  }
  
  return strings;
}

/**
 * Extract assistant text from protobuf response
 * 
 * Strategy:
 * 1. Parse Connect-RPC frames properly  
 * 2. Extract all strings from protobuf
 * 3. Find the longest meaningful text that looks like assistant output
 * 4. Filter out user prompt, hex IDs, paths, and metadata
 */
function extractTextFromResponse(data, userPrompt = '') {
  const allStrings = [];
  let offset = 0;
  let frameIndex = 0;
  
  // Parse Connect-RPC frames
  while (offset < data.length) {
    if (data.length - offset < 5) break;
    
    const compressed = data[offset];
    const length = data.readUInt32BE(offset + 1);
    
    if (data.length - offset < 5 + length) break;
    
    let payload = data.slice(offset + 5, offset + 5 + length);
    
    // Decompress if gzipped
    if (compressed === 1) {
      try { payload = zlib.gunzipSync(payload); } catch(e) {}
    }
    
    // Extract strings from this frame
    const strings = extractStringsFromProtobuf(payload);
    
    // Add frame index for later ranking
    for (const s of strings) {
      s.frameIndex = frameIndex;
    }
    allStrings.push(...strings);
    
    offset += 5 + length;
    frameIndex++;
  }
  
  // Normalize user prompt for comparison
  const userPromptLower = userPrompt.toLowerCase().trim();
  const userPromptWords = userPromptLower.split(/\s+/).filter(w => w.length > 3);
  
  // Filter and score candidates
  const candidates = allStrings
    .filter(s => {
      const t = s.text.trim();
      const tLower = t.toLowerCase();
      
      // Basic filters
      if (t.length === 0) return false;
      if (t.length > 2000) return false;  // Allow longer responses
      
      // Skip exact user prompt (case insensitive)
      if (tLower === userPromptLower) return false;
      
      // Skip if it contains the exact user prompt (echo)
      if (userPrompt && t.includes(userPrompt)) return false;
      
      // Skip hex IDs (16 or 32 char hex strings, with or without dashes)
      if (/^[0-9a-f]{16}$/i.test(t)) return false;
      if (/^[0-9a-f]{32}$/i.test(t)) return false;
      if (/^[0-9a-f-]{20,}$/i.test(t) && !t.includes(' ')) return false;
      
      // Skip metadata patterns
      if (t.includes('You are a powerful')) return false;
      if (t.includes('"role"')) return false;
      if (t.includes('providerOptions')) return false;
      if (t.includes('serverGenReqId')) return false;
      if (t.includes('user_query')) return false;
      if (t.includes('composer-1') || t.includes('Composer 1')) return false;
      if (t.includes('OpenCode session')) return false;
      if (t.includes('/context.txt')) return false;
      
      // Skip UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
      
      // Skip very short strings that are likely IDs or field names
      if (t.length < 3 && !/\w/.test(t)) return false;
      
      return true;
    })
    .map(s => {
      let score = 0;
      const t = s.text.trim();
      const tLower = t.toLowerCase();
      
      // STRONGLY prefer longer, complete-looking responses
      // Assistant responses are typically sentences/paragraphs
      if (t.length > 10) score += 20;
      if (t.length > 30) score += 30;
      if (t.length > 50) score += 50;
      
      // Bonus for containing sentence-like patterns
      if (/[.!?]$/.test(t)) score += 40;  // Ends with punctuation
      if (/^[A-Z]/.test(t)) score += 10;  // Starts with capital
      if (t.includes(' ')) score += 20;   // Has spaces (is a phrase)
      
      // STRONGLY prefer later frames (assistant response comes after initial state)
      // The user prompt echo is typically in early frames (0-5)
      // The assistant response is typically in later frames (10+)
      score += s.frameIndex * 10;
      if (s.frameIndex > 10) score += 50;  // Bonus for late frames
      
      // Prefer deeper nesting
      score += s.depth * 2;
      
      // HEAVILY penalize if it looks like user input echo
      // Check word overlap with user prompt
      let matchesUserWords = 0;
      for (const word of userPromptWords) {
        if (tLower.includes(word)) matchesUserWords++;
      }
      if (userPromptWords.length > 0) {
        const matchRatio = matchesUserWords / userPromptWords.length;
        if (matchRatio > 0.3) score -= 150;  // Some overlap with user input
        if (matchRatio > 0.5) score -= 300;  // Too similar to user input
        if (matchRatio > 0.8) score -= 500;  // Almost certainly the user input
      }
      
      // Check if the FULL response is contained in user prompt (likely echo)
      // But only if it's long enough to be meaningful
      if (t.length > 5 && userPromptLower.includes(tLower)) {
        score -= 1000;  // This response text was in the user's question
      }
      // Check if user prompt is contained in response (also likely echo)
      if (userPrompt.length > 5 && tLower.includes(userPromptLower)) {
        score -= 1000;  // User's full question is in this response
      }
      
      // Penalize file paths
      if (t.includes('/') && t.length < 50) score -= 50;
      
      // Penalize model display names
      if (/^[A-Z][a-z]+ [A-Z0-9][a-z0-9.-]*$/i.test(t)) score -= 30;
      
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);
  
  // Debug: log top candidates
  if (process.env.DEBUG) {
    console.log('Top 5 candidates:');
    candidates.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. score=${c.score} frame=${c.frameIndex} depth=${c.depth}: "${c.text.substring(0, 60)}..."`);
    });
  }
  
  // Return the best candidate
  if (candidates.length > 0) {
    return candidates[0].text.trim();
  }
  
  return '';
}

/**
 * Stream chat via HTTP/2 to Cursor's agent using protobuf
 */
function streamChat(model, messages, onData, onEnd, onError) {
  const token = getToken();
  
  // Helper to extract text from content (handles string or array format)
  const extractText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
    return String(content || '');
  };
  
  // Get the last user message
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const prompt = extractText(lastUserMsg?.content);
  
  // Build context from conversation history
  const context = messages.map(m => `${m.role}: ${extractText(m.content)}`).join('\n');
  
  // Build protobuf request
  const { payload } = buildProtobufRequest(prompt, model, context);
  const frame = createFrame(payload);
  
  const client = http2.connect(`https://${AGENT_BASE}`);
  
  let responseData = Buffer.alloc(0);
  let lastDataTime = Date.now();
  
  client.on('error', (err) => {
    console.error('  HTTP/2 client error:', err.message);
    onError(err);
  });
  
  const stream = client.request({
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': CLIENT_VERSION,
    'x-ghost-mode': 'false',
    'x-request-id': randomUUID(),
  });
  
  // Check for idle (response complete)
  const idleCheck = setInterval(() => {
    if (Date.now() - lastDataTime > 3000 && responseData.length > 0) {
      clearInterval(idleCheck);
      console.log(`  Idle timeout - Response: ${responseData.length} bytes`);
      const text = extractTextFromResponse(responseData, prompt);
      console.log(`  Extracted text: "${text.substring(0, 100)}..."`);
      if (text) onData(text);
      onEnd();
      client.close();
    }
  }, 500);
  
  stream.on('response', (headers) => {
    console.log(`  Cursor API status: ${headers[':status']}`);
    if (headers[':status'] !== 200) {
      clearInterval(idleCheck);
      onError(new Error(`HTTP ${headers[':status']}`));
      client.close();
    }
  });
  
  stream.on('data', (chunk) => {
    lastDataTime = Date.now();
    responseData = Buffer.concat([responseData, chunk]);
  });
  
  stream.on('end', () => {
    clearInterval(idleCheck);
    console.log(`  Response received: ${responseData.length} bytes`);
    const text = extractTextFromResponse(responseData, prompt);
    console.log(`  Extracted text: "${text.substring(0, 100)}..."`);
    if (text) onData(text);
    onEnd();
    client.close();
  });
  
  stream.on('error', (err) => {
    clearInterval(idleCheck);
    onError(err);
    client.close();
  });
  
  stream.write(frame);
  stream.end();
  
  // Hard timeout
  setTimeout(() => {
    clearInterval(idleCheck);
    console.log(`  Hard timeout - Response: ${responseData.length} bytes`);
    const text = extractTextFromResponse(responseData, prompt);
    if (text) onData(text);
    onEnd();
    client.close();
  }, 60000);
}

// Make HTTP/2 Connect-RPC JSON request (for models endpoint)
async function connectRequest(host, service, method, body = {}) {
  const token = getToken();
  const postData = JSON.stringify(body);
  
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    
    client.on("error", reject);
    
    const req = client.request({
      ":method": "POST",
      ":path": `/${service}/${method}`,
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "accept": "application/json",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": CLIENT_VERSION,
      "x-ghost-mode": "false",
      "x-request-id": randomUUID(),
    });
    
    let data = "";
    req.on("data", (chunk) => data += chunk);
    req.on("end", () => {
      client.close();
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    });
    req.on("error", (err) => {
      client.close();
      reject(err);
    });
    
    req.write(postData);
    req.end();
  });
}

// Handle incoming requests
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Read body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  let json = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {}
  
  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);
  
  try {
    // GET /v1/models - list available models
    if (path === "/v1/models" && req.method === "GET") {
      const result = await connectRequest(AGENT_BASE, "agent.v1.AgentService", "GetUsableModels");
      
      const models = (result.models || []).map(m => ({
        id: m.modelId,
        object: "model",
        created: Date.now(),
        owned_by: "cursor",
      }));
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    
    // POST /v1/chat/completions - chat
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const { model = 'composer-1', messages = [], stream = false } = json;
      
      console.log(`  Model: ${model}, Messages: ${messages.length}, Stream: ${stream}`);
      
      if (stream) {
        // Streaming response (SSE)
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        
        const responseId = `chatcmpl-${randomUUID()}`;
        
        streamChat(
          model,
          messages,
          // onData
          (text) => {
            if (text) {
              const eventData = {
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                }],
              };
              res.write(`data: ${JSON.stringify(eventData)}\n\n`);
            }
          },
          // onEnd
          () => {
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          },
          // onError
          (err) => {
            console.error("Stream error:", err.message);
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
          }
        );
        return;
      }
      
      // Non-streaming response
      let fullResponse = "";
      
      await new Promise((resolve, reject) => {
        streamChat(
          model,
          messages,
          (text) => { fullResponse += text; },
          resolve,
          reject
        );
      });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: fullResponse || "No response received" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
      return;
    }
    
    // Unknown endpoint
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path }));
    
  } catch (err) {
    console.error("Error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Start server
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         Cursor API Proxy Server (Protobuf)        ║
╠═══════════════════════════════════════════════════╣
║  Listening on: http://localhost:${PORT}             ║
║  OpenAI-compatible endpoint: /v1/chat/completions ║
║  Models endpoint: /v1/models                      ║
╠═══════════════════════════════════════════════════╣
║  Configure OpenCode with:                         ║
║    "provider": {                                  ║
║      "cursor": {                                  ║
║        "api": "http://localhost:${PORT}/v1"         ║
║      }                                            ║
║    }                                              ║
╠═══════════════════════════════════════════════════╣
║  Available models: composer-1, gpt-5.2-codex,     ║
║    claude-4.5-sonnet, claude-4-opus, gemini-2.5,  ║
║    grok-3, o4, and more...                        ║
╠═══════════════════════════════════════════════════╣
║  Token: Loaded from macOS Keychain                ║
╚═══════════════════════════════════════════════════╝
`);
});
