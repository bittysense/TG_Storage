export async function onRequestGet(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response(JSON.stringify([]), { status: 500 });

  try {
    // 1. 🌟 直接扫描所有分卷账本的 Key 名字（消耗 1 次读取额度）
    const listResult = await kv.list({ prefix: 'system:video_list:' });
    
    // 如果一个账本都没有，直接返回空
    if (listResult.keys.length === 0) {
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. 提取出所有的 Key 名，并按照名称排序（确保账本顺序不乱，如 :1, :2, :3）
    // KV 的 list 默认就是按字母字典序升序排列的
    const sortedKeys = listResult.keys.map(k => k.name);

    // 3. 🌟 并发读取所有账本的内容（消耗 N 次读取额度）
    const readPromises = sortedKeys.map(keyName => kv.get(keyName, { type: 'json' }));
    const allLedgers = await Promise.all(readPromises);

    let masterVideoList = [];

    // 4. 逆向合并数据（最新册的排在最前，也就是数组尾部的账本先合并）
    for (let i = allLedgers.length - 1; i >= 0; i--) {
      const ledgerData = allLedgers[i];
      if (ledgerData && Array.isArray(ledgerData)) {
        masterVideoList = masterVideoList.concat(ledgerData);
      }
    }

    // 5. 吐给前端全量合拢数据（带 10 秒边缘强缓存保护）
    return new Response(JSON.stringify(masterVideoList), {
      headers: { 
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=10' 
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}