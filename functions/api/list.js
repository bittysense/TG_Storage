export async function onRequestGet(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response(JSON.stringify([]), { status: 500 });

  try {
    // 🌟 降维打击：无论有多少视频，永远只执行 1 次 kv.get 读出全部列表
    const globalList = await kv.get('system:video_list', { type: 'json' });
    
    // 如果从来没上传过，优雅返回空数组
    const result = globalList || [];

    return new Response(JSON.stringify(result), {
      headers: { 
        'Content-Type': 'application/json; charset=utf-8',
        // 顺手加上 1 分钟的浏览器/边缘节点强缓存，防止用户在前台按 F5 连击刷新网页
        'Cache-Control': 'public, max-age=60'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}