export async function onRequestPost(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response(JSON.stringify({ success: false, error: '未绑定 KV' }), { status: 500 });

  try {
    const body = await context.request.json();
    const { uid, name, size, chunks } = body;

    if (!uid || !chunks || chunks.length === 0) {
      return new Response(JSON.stringify({ success: false, error: '结算参数不完整' }), { status: 400 });
    }

    // 构建标准元数据资产账本
    const metaData = {
      uid: uid,
      name: name,
      size: size,
      chunks: chunks, // 按前端严格排序好的 file_id 数组
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };

    // 🌟 全程唯一的一次 KV 写入操作，定鼎乾坤！
    await kv.put(`file:${uid}`, JSON.stringify(metaData));

    return new Response(JSON.stringify({ success: true, meta: metaData }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}