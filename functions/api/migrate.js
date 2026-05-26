export async function onRequestGet(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response('未绑定 KV 数据库', { status: 500 });

  try {
    // 1. 扫描所有以 file: 开头的键
    const listResult = await kv.list({ prefix: 'file:' });
    let oldVideoCount = 0;
    let ledger1 = [];
    let debugInfo = []; // 用于捕捉前几条数据的真实结构

    for (const key of listResult.keys) {
      const meta = await kv.get(key.name, { type: 'json' });
      
      // 🌟 核心改进：只要能从 Key 名里切出 uid，就强行收录
      const keyParts = key.name.split(':');
      const extractedUid = keyParts[keyParts.length - 1]; // 拿到 vid_xxxx

      if (extractedUid && extractedUid.startsWith('vid_')) {
        // 顺便抓取前 3 条老数据的样子，万一失败了方便断案
        if (oldVideoCount < 3) {
          debugInfo.push({ key: key.name, content: meta });
        }

        ledger1.push({
          uid: extractedUid, // 强行使用从 Key 名字里提取出来的 UID
          name: (meta && meta.name) ? meta.name : '未命名老视频',
          size: (meta && meta.size) ? meta.size : 0,
          time: (meta && meta.time) ? meta.time : new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        });
        oldVideoCount++;
      }
    }

    if (oldVideoCount === 0) {
      return new Response(`🔍 扫描结束。依然没有找到有效的 file: 资产。\n云端实际返回的 Key 列表数量为: ${listResult.keys.length} 个。`);
    }

    // 按时间倒序排列
    ledger1.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 2. 强行灌入新分卷账本 1
    await kv.put('system:video_list:1', JSON.stringify(ledger1));

    return new Response(`🎉 【终极兼容版】完美修复成功！\n\n` +
                        `1. 已成功将 ${oldVideoCount} 个老视频资产强行注入【新分卷账本 1】。\n` +
                        `2. 现在去刷新后台列表或者 list.js，老视频必定全部回归！\n\n` +
                        `🔍 附前几条老资产的底层结构快照（供参考）:\n` + 
                        JSON.stringify(debugInfo, null, 2));

  } catch (err) {
    return new Response(`❌ 迁移发生严重错误: ${err.message}`, { status: 500 });
  }
}