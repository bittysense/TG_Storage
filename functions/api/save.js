export async function onRequestPost(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response(JSON.stringify({ success: false, error: '未绑定 KV' }), { status: 500 });

  try {
    const body = await context.request.json();
    const { uid, name, size, chunks } = body;

    if (!uid || !chunks || chunks.length === 0) {
      return new Response(JSON.stringify({ success: false, error: '结算参数不完整' }), { status: 400 });
    }

    const uploadTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 1. 组装并写入该视频的【详细大账本】（供播放器使用）
    const metaData = {
      uid: uid,
      name: name,
      size: size,
      chunks: chunks,
      time: uploadTime
    };
    await kv.put(`file:${uid}`, JSON.stringify(metaData));

    // 2. 🌟 核心优化：动态更新【全局轻量总账本】（供 list.js 使用）
    // 异步锁/原子性在低频个人盘中可以通过先读后写简单实现
    let globalList = await kv.get('system:video_list', { type: 'json' }) || [];
    
    // 过滤掉同名旧 UID 防止重复，然后将新视频的精简元数据推入头部（最新上传在最前）
    globalList = globalList.filter(item => item.uid !== uid);
    globalList.unshift({
      uid: uid,
      name: name,
      size: size,
      time: uploadTime
    });

    // 严格限制全局总账本的大小（例如只保留最近上传的 500 部视频，防止单次请求过大）
    if (globalList.length > 500) {
      globalList = globalList.slice(0, 500);
    }

    // 写入总账本
    await kv.put('system:video_list', JSON.stringify(globalList));

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}