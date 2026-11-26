import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const origin = 'https://jokerzhe321-creator.github.io';
const hash = value => createHash('sha256').update(value).digest();
const { OPENAI_API_KEY, RYAN_ACCESS_CODE } = process.env;
if (!OPENAI_API_KEY || !RYAN_ACCESS_CODE) throw Error('Missing server configuration');
let inFlight = 0;

http.createServer(async (req, res) => {
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (req.url === '/health') return reply(200, { ready: true });
  if (req.url !== '/chat') return reply(404, {});
  if (req.headers.origin && req.headers.origin !== origin) return reply(403, {});
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') return reply(405, {});
  if (!timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer ' + RYAN_ACCESS_CODE))) return reply(401, {error:'请输入正确的工作台访问码'});
  if (inFlight >= 3) return reply(429, {error:'请稍后重试'});
  inFlight++;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 90000) return reply(413, {error:'内容过长'});
      chunks.push(chunk);
    }
    let messages;
    try { messages = JSON.parse(Buffer.concat(chunks)).messages; } catch { return reply(400, {}); }
    if (!Array.isArray(messages) || !messages.length || messages.length > 12 || messages.at(-1)?.role !== 'user' ||
      !messages.every(m => ['user','assistant'].includes(m?.role) && typeof m.content === 'string' && m.content.trim() && m.content.length <= 10000)) return reply(400, {error:'消息格式或长度有误'});
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', headers:{Authorization:'Bearer ' + OPENAI_API_KEY,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(55000),
      body:JSON.stringify({model:'gpt-4.1-mini',store:false,max_output_tokens:1800,
        instructions:'你是 Ryan 在墨尔本的私人工作助理。默认用中文，根据要求生成可直接使用的报价、邮件草稿、教学计划。不要声称已经发信、设提醒或访问外部数据。用户明确要求添加待办时，调用 add_task。任务保存在当前设备，无定时通知。',
        input:messages.map(({role,content})=>({role,content})),
        tools:[{type:'function',name:'add_task',description:'在当前设备的工作任务中添加用户要求的待办',strict:true,parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}]})
    });
    if (!upstream.ok) return reply(502,{error:'AI 服务暂时无法回答，请稍后重试'});
    const result = await upstream.json();
    const tasks = [], parts = [];
    for (const item of result.output || []) {
      if (item.type === 'message') for (const part of item.content || []) { if (part.text || part.refusal) parts.push(part.text || part.refusal); }
      if (item.type === 'function_call' && item.name === 'add_task') {
        const title = JSON.parse(item.arguments).title;
        if (typeof title === 'string' && title.trim()) tasks.push(title.trim().slice(0,500));
      }
    }
    if (!parts.length && !tasks.length) return reply(502,{error:'未收到完整回答，请重试'});
    reply(200,{text:parts.join('\n'),tasks});
  } catch { reply(502,{error:'请求中断，请重试'}); }
  finally { inFlight--; }
}).listen(Number(process.env.PORT || 10000),'0.0.0.0');
