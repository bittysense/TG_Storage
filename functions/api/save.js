export async function onRequestPost(context) {
  const kv = context.env.TG_STORAGE_KV;
  if (!kv) return new Response(JSON.stringify({ success: false, error: '未绑定 KV 数据库' }), { status: 500 });

  try {
    const body = await context.request.json();
    const { uid, name, size, chunks } = body;

    // 安全检查
    if (!uid || !chunks || chunks.length === 0) {
      return new Response(JSON.stringify({ success: false, error: '结算参数不完整' }), { status: 400 });
    }

    const uploadTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 1. 🚀 写入当前视频的【详细大账本】（供播放器 stream 路由使用，带 chunks 详情）
    const metaData = {
      uid: uid,
      name: name,
      size: size,
      chunks: chunks,
      time: uploadTime
    };
    await kv.put(`file:${uid}`, JSON.stringify(metaData));

    // 2. 🌟 智能动态探测：直接扫描现有的分卷账本，决定写入目标
    const listResult = await kv.list({ prefix: 'system:video_list:' });
    
    let targetLedgerIdx = 1;
    let currentLedger = [];

    if (listResult.keys.length > 0) {
      // 提取所有现存的分卷 Key 名称
      const keyNames = listResult.keys.map(k => k.name);
      
      // 提取出所有的数字编号并找出最大值（例如从 ["system:video_list:1", "system:video_list:2"] 中找出 2）
      const indices = keyNames.map(name => {
        const parts = name.split(':');
        return parseInt(parts[parts.length - 1], 10);
      }).filter(num => !isNaN(num));

      if (indices.length > 0) {
        // 锁定当前最新的活跃账本编号
        targetLedgerIdx = Math.max(...indices);
      }
      
      // 读取这个最新账本里面的内容
      const latestLedgerKey = `system:video_list:${targetLedgerIdx}`;
      currentLedger = await kv.get(latestLedgerKey, { type: 'json' }) || [];
    }

    // 3. 💥 阈值熔断检查：如果这一册满了（设定单册最大存 5000 条精简记录）
    const MAX_ITEMS_PER_LEDGER = 5000;
    if (currentLedger.length >= MAX_ITEMS_PER_LEDGER) {
      // 自动进位：创建下一册账本
      targetLedgerIdx += 1;
      currentLedger = []; // 新账本初始为空
    }

    // 4. 将当前视频的精简元数据推入当前活跃账本的头部（最新上传在最前）
    currentLedger.unshift({
      uid: uid,
      name: name,
      size: size,
      time: uploadTime
    });

    // 5. 🎯 终极落锁写入分卷总账本
    const finalLedgerKey = `system:video_list:${targetLedgerIdx}`;
    await kv.put(finalLedgerKey, JSON.stringify(currentLedger));

    return new Response(JSON.stringify({ 
      success: true, 
      msg: '资产结算成功', 
      saved_in_ledger: targetLedgerIdx 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}