export async function onRequestGet(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response('未绑定 KV', { status: 500 });

  // 列出 KV 中所有以 "file:" 开头的键
  const listResult = await kv.list({ prefix: 'file:' });
  const files = [];

  for (const keyObj of listResult.keys) {
    const meta = await kv.get(keyObj.name, { type: 'json' });
    if (meta) {
      files.push({
        uid: keyObj.name.replace('file:', ''), // 提取出 UID
        name: meta.name,
        size: meta.size,
        totalChunks: meta.totalChunks
      });
    }
  }

  return new Response(JSON.stringify(files), {
    headers: { 'Content-Type': 'application/json' }
  });
}