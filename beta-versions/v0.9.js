/**
 * 1nuo 财富中枢 V0.90 Stable 
 * ---------------------------------------
 * 核心升级：
 * 1. AI 账单全修正 (彻底修复改不动账户的问题)
 * 2. 数据库异步锁 (解决记账不入库的问题)
 * 3. 账户标准化归一 (mapAccount 函数多点触发)
 * 4. 满血 Reasoner 审计与原生 MD 渲染
 */

// ==========================================
// 核心工具函数：强力 JSON 提取
// ==========================================
function extractJSON(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const jsonStr = text.substring(start, end + 1).replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("JSON解析底层异常:", e);
    return null;
  }
}

// ==========================================
// 核心工具函数：账户名称映射 (核心保险盒)
// ==========================================
function mapAccount(name) {
  const n = name || "";
  if (n.includes("微信")) return "微信";
  if (n.includes("支付宝")) return "支付宝";
  if (n.includes("花呗")) return "花呗";
  if (n.includes("余额宝")) return "余额宝";
  if (n.includes("卡")) return "银行卡";
  if (n.includes("现金")) return "现金";
  return n;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
        // ==========================================
        // API：AI 快速记账 (POST /api/record)
        // ==========================================
        if (request.method === 'POST' && url.pathname === '/api/record') {
            const { text } = await request.json();
            
            // 调用 DeepSeek-Chat
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: '你是专业会计。提取JSON：{"amount":数字,"category":"原始分类","account":"账户名","description":"描述","type":"expense/income"}。账户名必选：微信, 支付宝, 余额宝, 花呗, 银行卡。严禁篡改用户分类！' },
                        { role: 'user', content: text }
                    ],
                    response_format: { type: 'json_object' }
                })
            });
            const resJson = await dsRes.json();
            const parsed = extractJSON(resJson.choices[0].message.content);
            if (!parsed) throw new Error("AI未能理解账单内容，请检查描述");

            // 数据暴力清洗与映射
            const cleanAmount = parseFloat(String(parsed.amount).replace(/[^\d.]/g, '')) || 0;
            const cleanAccount = mapAccount(parsed.account);
            const finalCategory = parsed.category || "其它";

            // 如果是余额宝，同步更新基金表本金
            if (cleanAccount === '余额宝') {
                const change = (parsed.type === 'income') ? cleanAmount : -cleanAmount;
                await env.DB.prepare("UPDATE funds SET principal = principal + ? WHERE fund_code = '161608'").bind(change).run();
            }

            // 数据库写入 (加锁等待)
            await env.DB.prepare("INSERT INTO bills (amount, category, account, description, type) VALUES (?, ?, ?, ?, ?)")
                .bind(cleanAmount, finalCategory, cleanAccount, parsed.description || "", parsed.type || "expense")
                .run();
            
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：全量 AI 修改 (PUT /api/record/:id)
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/record/')) {
            const id = url.pathname.split('/').pop();
            const { text } = await request.json();

            // 1. 先查出旧记录，作为参考传给 AI
            const oldRecord = await env.DB.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first();
            
            // 2. 让 AI 处理修正
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: '修正账本。输出JSON。账户必须在[微信,支付宝,余额宝,花呗,银行卡]中。如果用户说改支付方式，你必须更新account字段。' },
                        { role: 'user', content: `原记录：${JSON.stringify(oldRecord)}。修正指令：${text}` }
                    ],
                    response_format: { type: 'json_object' }
                })
            });
            const resJson = await dsRes.json();
            const parsed = extractJSON(resJson.choices[0].message.content);
            if (!parsed) throw new Error("修正指令解析失败");

            const cleanAmount = parseFloat(String(parsed.amount).replace(/[^\d.]/g, '')) || 0;
            const cleanAccount = mapAccount(parsed.account);

            // 3. 更新数据库
            await env.DB.prepare("UPDATE bills SET amount=?, category=?, account=?, description=?, type=? WHERE id=?")
                .bind(cleanAmount, parsed.category, cleanAccount, parsed.description, parsed.type, id)
                .run();

            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：Reasoner 深度审计 (POST /api/analyze)
        // ==========================================
        if (request.method === 'POST' && url.pathname === '/api/analyze') {
            const data = await request.json();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-reasoner', // 强制推理模型
                    messages: [
                        { 
                          role: 'system', 
                          content: '你是资产审计官。请分析提供的财务快照（资产、流水、基金盈亏），输出带有深度逻辑的 Markdown 审计报告。严禁输出任何代码块标记，直接给文字。' 
                        },
                        { role: 'user', content: JSON.stringify(data) }
                    ]
                })
            });
            const res = await dsRes.json();
            return new Response(JSON.stringify({ analysis: res.choices[0].message.content }));
        }

        // ==========================================
        // 其他基础 API (基金调仓/账户调平/删除)
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/fund/')) {
            const code = url.pathname.split('/').pop();
            const { text, nav } = await request.json();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'system', content: `基金助手。净值:${nav}。返回:{"principal":数字,"shares":数字}` }, { role: 'user', content: text }]
                })
            });
            const parsed = extractJSON((await dsRes.json()).choices[0].message.content);
            await env.DB.prepare("UPDATE funds SET shares=?, principal=? WHERE fund_code=?").bind(parsed.shares, parsed.principal, code).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'PUT' && url.pathname.startsWith('/api/account/')) {
            const name = decodeURIComponent(url.pathname.split('/').pop());
            const { text } = await request.json();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'system', content: '账户调平助手。返回:{"balance":数字,"limit":数字}' }, { role: 'user', content: text }]
                })
            });
            const parsed = extractJSON((await dsRes.json()).choices[0].message.content);
            await env.DB.prepare("UPDATE accounts SET balance=?, credit_limit=? WHERE account_name=?").bind(parsed.balance, parsed.limit, name).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/api/record/')) {
            await env.DB.prepare("DELETE FROM bills WHERE id = ?").bind(url.pathname.split('/').pop()).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // 渲染层 (GET)：马卡龙淡粉高级 UI
        // ==========================================
        if (request.method === 'GET') {
            const { results: accBases } = await env.DB.prepare("SELECT * FROM accounts").all();
            let accounts = {}; accBases.forEach(a => { accounts[a.account_name] = { type: a.type, limit: a.credit_limit, balance: a.balance }; });
            
            const { results: allBills } = await env.DB.prepare("SELECT * FROM bills ORDER BY id DESC").all();
            let spentThisMonth = 0; const currentMonth = new Date().toISOString().slice(0, 7);

            allBills.forEach(b => {
                if (b.created_at && b.created_at.startsWith(currentMonth) && b.type === 'expense') spentThisMonth += b.amount;
                const acc = accounts[b.account] || { balance: 0, type: 'asset', limit: 0 };
                if (b.type === 'expense') { 
                    if (acc.type === 'liability') acc.balance += b.amount; else acc.balance -= b.amount; 
                } else if (b.type === 'income') { 
                    if (acc.type === 'liability') acc.balance -= b.amount; else acc.balance += b.amount; 
                }
            });

            const { results: myFunds } = await env.DB.prepare("SELECT * FROM funds").all();
            let fundTotalAsset = 0; let fundTotalPnl = 0; let fundTotalDailyPnl = 0;
            let activeFundHtml = ''; let yuebaoHtml = ''; let fundDataForAI = [];

            try {
                const sinaRes = await fetch(`https://hq.sinajs.cn/list=f_${myFunds.map(f=>f.fund_code).join(',f_')}`, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
                const sinaStr = await sinaRes.text();
                myFunds.forEach(fund => {
                    const match = sinaStr.match(new RegExp(`f_${fund.fund_code}="([^,]+),([0-9.]+),([0-9.]+),([0-9.]+),`));
                    let nav = (match && parseFloat(match[2]) > 0) ? parseFloat(match[2]) : 1;
                    let yest_nav = match ? parseFloat(match[4]) : nav;
                    const principal = fund.principal || 0; 
                    const currentValue = nav * fund.shares;
                    const totalPnl = currentValue - principal;
                    const dailyPnl = fund.shares * (nav - yest_nav);
                    
                    fundTotalAsset += currentValue; fundTotalPnl += totalPnl; fundTotalDailyPnl += dailyPnl;
                    fundDataForAI.push({ name: fund.fund_name, pnl: totalPnl });

                    const itemHtml = `
                    <div class="fund-card">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <b style="font-size:14px;">${fund.fund_name}</b>
                            <b style="font-size:15px; color:#333;">¥${currentValue.toFixed(2)}</b>
                        </div>
                        <div style="font-size:11px; margin-top:8px; display:flex; justify-content:space-between; color:#666;">
                            <span>累计: <b style="color:${totalPnl>=0?'#e74c3c':'#2ecc71'}">${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}</b></span>
                            <span>今日: <b style="color:${dailyPnl>=0?'#e74c3c':'#2ecc71'}">${dailyPnl>=0?'+':''}${dailyPnl.toFixed(2)}</b></span>
                        </div>
                        <div style="text-align:right; margin-top:10px;">
                            <span class="btn-tiny" onclick="window.editFund('${fund.fund_code}', ${fund.shares}, ${principal}, ${nav})">🤖 调仓</span>
                        </div>
                    </div>`;
                    if (fund.fund_code === '161608') yuebaoHtml = itemHtml; else activeFundHtml += itemHtml;
                });
            } catch (e) {}

            let accountsHtml = ''; let totalLiabilities = 0; let liquidAssets = 0;
            Object.keys(accounts).forEach(name => {
                if (name === '余额宝') return;
                const acc = accounts[name];
                if (acc.type === 'liability') { 
                    totalLiabilities += acc.balance;
                    accountsHtml += `<div class="list-row"><span>${name}</span><div style="text-align:right;"><b style="color:#ff4d4f;">-¥${acc.balance.toFixed(2)}</b><br><small style="color:#999;font-size:10px;">可用 ¥${(acc.limit - acc.balance).toFixed(2)} / 总额 ¥${acc.limit}</small> <span class="btn-tiny" onclick="window.editAccount('${name}', ${acc.balance}, ${acc.limit})">🤖 调额</span></div></div>`;
                } else {
                    liquidAssets += acc.balance;
                    accountsHtml += `<div class="list-row"><span>${name}</span><span><b>¥${acc.balance.toFixed(2)}</b> <span class="btn-tiny" onclick="window.editAccount('${name}', ${acc.balance}, ${acc.limit})">🤖 调平</span></span></div>`;
                }
            });

            const GRAND_TOTAL = liquidAssets + fundTotalAsset - totalLiabilities;
            const remaining = 1500 - spentThisMonth;
            const finalReport = { budget: 1500, spent: spentThisMonth, assets: GRAND_TOTAL, funds: fundDataForAI };

            return new Response(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>1nuo 财富中枢 V0.90 Stable</title>
                <script src="https://cdn.staticfile.org/marked/4.2.2/marked.min.js"></script>
                <style>
                    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #fff5f7 0%, #ffffff 100%); margin:0; padding:15px; display:flex; justify-content:center; min-height: 100vh; }
                    .container { max-width: 1000px; width: 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 15px; }
                    .card { background:rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); border-radius:24px; padding:20px; box-shadow:0 8px 30px rgba(255, 182, 193, 0.15); border: 1px solid #fff1f3; }
                    .card-header { font-weight:bold; font-size:15px; margin-bottom:12px; color:#ffb7c5; border-left:4px solid #ffb7c5; padding-left:10px; display:flex; justify-content:space-between; align-items:center; }
                    .big-num { font-size:45px; font-weight:900; color:#ffb7c5; letter-spacing:-1.5px; margin:5px 0; }
                    textarea { width:100%; height:65px; padding:12px; border-radius:18px; border:2px solid #fff1f3; box-sizing:border-box; font-size:14px; outline:none; background: #fff; }
                    button { width:100%; padding:14px; background:#ffb7c5; color:white; border:none; border-radius:18px; font-weight:bold; margin-top:10px; cursor:pointer; font-size:15px; }
                    .list-row { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #fff5f6; font-size:14px; align-items:center; }
                    .bill-item { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #fff5f6; font-size:13px; }
                    .fund-card { background:#fffafa; border-radius:18px; padding:15px; margin-bottom:10px; border:1px solid #fff1f3; }
                    .btn-tiny { font-size:10px; color:#ffb7c5; border:1px solid #ffb7c5; padding:2px 6px; border-radius:10px; cursor:pointer; margin-left:4px; }
                    .ai-box { background:rgba(255,255,255,0.9); border-radius:20px; padding:18px; margin-top:10px; font-size:13px; border: 1px dashed #ffb7c5; color:#666; line-height:1.7; }
                    .ai-box h3 { margin: 8px 0; color: #ff8da1; }
                </style>
            </head>
            <body>
            <div class="container">
                <div class="card" style="background:linear-gradient(90deg, #ffb7c5, #fecfef); color:white; grid-column: 1 / -1;">
                    <div style="opacity:0.9; font-size:13px;">动态净资产总额</div>
                    <div class="big-num" style="color:white;">¥${GRAND_TOTAL.toFixed(2)}</div>
                    <div style="font-size:12px; opacity:0.9;">✨ 累计盈亏: ${fundTotalPnl.toFixed(2)} | 今日: ${fundTotalDailyPnl.toFixed(2)}</div>
                </div>

                <div class="card">
                    <div class="card-header">AI 快速记账</div>
                    <textarea id="recordInput" placeholder="描述开销，如：王者充值50微信付..."></textarea>
                    <button id="recordBtn" onclick="window.submitRecord()">立即入账</button>
                    <div style="margin-top:20px; font-size:14px;">本月剩余预算: <b style="color:#ffb7c5;">¥${remaining.toFixed(2)}</b></div>
                    <div class="card-header" style="margin-top:20px;">最近流水</div>
                    ${allBills.slice(0, 6).map(b => `<div class="bill-item">
                        <div style="flex:1;"><b>${b.description || b.category}</b><br><small style="color:#aaa;">${b.account}</small></div>
                        <div style="text-align:right;"><b style="color:${b.type==='income'?'#2ecc71':'#444'}">${b.type==='income'?'+':'-'}${b.amount.toFixed(2)}</b><br>
                        <small onclick="window.editBill(${b.id}, '${(b.description || b.category).replace(/'/g, "\\'")}')" style="color:#ffb7c5; cursor:pointer;">[改]</small>
                        <small onclick="window.deleteBill(${b.id})" style="color:#ccc; cursor:pointer; margin-left:5px;">[删]</small></div>
                    </div>`).join('')}
                </div>

                <div class="right-col">
                    <div class="card" style="background:#fffcf0; border-color:#ffe58f; margin-bottom:15px;">
                        <div class="card-header" style="color:#d48806; border-color:#d48806;">💰 余额宝专区</div>
                        ${yuebaoHtml || '<small style="color:#999;">暂无数据</small>'}
                    </div>
                    <div class="card">
                        <div class="card-header">💳 资产分布与详情</div>
                        ${accountsHtml}
                    </div>
                </div>

                <div class="card" style="grid-column: 1 / -1;">
                    <div class="card-header" style="color:#ffb7c5;">🧠 AI Reasoner 财务审计 
                        <button onclick="window.runAudit()" id="auditBtn" style="width:auto; padding:4px 15px; margin:0; float:right; font-size:12px;">一键审计</button>
                    </div>
                    <div id="aiRes" class="ai-box">点击获取由 R1 模型驱动的深度审计报告...</div>
                </div>

                <div class="card" style="grid-column: 1 / -1;">
                    <div class="card-header">📈 投资雷达</div>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">${activeFundHtml}</div>
                </div>
            </div>

            <script>
                // 全局数据
                window.auditData = ${JSON.stringify(finalReport)};

                window.submitRecord = async function() {
                    const btn = document.getElementById('recordBtn'); const text = document.getElementById('recordInput').value;
                    if(!text) return; btn.innerText = '解析入库中...';
                    try {
                        const res = await fetch('/api/record', { method: 'POST', body: JSON.stringify({ text }) });
                        if(res.ok) location.reload(); else throw new Error();
                    } catch(e) { alert('记账失败，请检查网络或API余额'); btn.innerText = '立即入账'; }
                };

                window.runAudit = async function() {
                    const btn = document.getElementById('auditBtn'); const box = document.getElementById('aiRes');
                    btn.innerText = '逻辑推理中...'; box.innerText = 'AI 正在调取全量流水并深度思考...';
                    try {
                        const res = await fetch('/api/analyze', { method: 'POST', body: JSON.stringify(window.auditData) });
                        const data = await res.json();
                        box.innerHTML = marked.parse(data.analysis);
                    } catch(e) { box.innerText = '审计超时，建议刷新重试'; }
                    finally { btn.innerText = '一键审计'; }
                };

                window.editBill = async function(id, old) {
                    const text = prompt('全量修正该账单(例如：其实是微信付了50元吃火锅)：', old);
                    if(text) { 
                        document.body.style.opacity = '0.5';
                        const res = await fetch('/api/record/'+id, { method: 'PUT', body: JSON.stringify({ text }) });
                        if(res.ok) location.reload(); else alert('修正失败');
                    }
                };

                window.editAccount = async function(name, b, l) {
                    const text = prompt('账户AI修正(如：余额改成100 或 额度调到5000)：');
                    if(text) { 
                        document.body.style.opacity = '0.5';
                        await fetch('/api/account/'+encodeURIComponent(name), {method:'PUT', body:JSON.stringify({text})});
                        location.reload(); 
                    }
                };

                window.editFund = async function(code, s, p, nav) {
                    const text = prompt('基金AI调仓(如：今天又加仓了1000元)：');
                    if(text) { 
                        document.body.style.opacity = '0.5';
                        await fetch('/api/fund/'+code, {method:'PUT', body:JSON.stringify({text, nav})});
                        location.reload(); 
                    }
                };

                window.deleteBill = async function(id) { if(confirm('确定删除这笔明细吗？')) { await fetch('/api/record/'+id, {method:'DELETE'}); location.reload(); } };
            </script>
            </body></html>
            `, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

    } catch (e) { return new Response("系统级崩溃: " + e.message, { status: 500 }); }
  }
}