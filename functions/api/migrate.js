export async function onRequestGet(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response('未绑定 KV 数据库', { status: 500 });

  try {
    // 1. 扫描 KV 中所有以 file: 开头的单个老视频大账本
    const listResult = await kv.list({ prefix: 'file:' });
    let oldVideoCount = 0;
    let ledger1 = [];

    // 2. 循环读取这些老数据，提取出名字、大小和时间
    for (const key of listResult.keys) {
      const meta = await kv.get(key.name, { type: 'json' });
      if (meta && meta.uid) {
        ledger1.push({
          uid: meta.uid,
          name: meta.name || '未命名老视频',
          size: meta.size || 0,
          time: meta.time || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        });
        oldVideoCount++;
      }
    }

    if (oldVideoCount === 0) {
      return new Response('🔍 检查结果：你的 KV 中似乎还没有任何以 file: 开头的历史老视频，无需迁移。');
    }

    // 按时间倒序排列（新上传的在前）
    ledger1.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 3. 🌟 核心对齐：直接把这些老视频打包，写入无指针架构的第一册账本
    await kv.put('system:video_list:1', JSON.stringify(ledger1));

    return new Response(`🎉 老数据完美修复！已成功将 ${oldVideoCount} 个历史老视频一次性灌入到【新分卷账本 1】中。现在可以去刷新 list.js 了！`);
  } catch (err) {
    return new Response(`❌ 迁移失败: ${err.message}`, { status: 500 });
  }
}