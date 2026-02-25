/**
 * 1nuo 财富中枢 V1.1 (预算精细化 & 强制纠偏版)
 */

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
        // API：日常记账
        // ==========================================
        if (request.method === 'POST' && url.pathname === '/api/record') {
            const { text } = await request.json();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: '你是专业会计。提取JSON：{"amount":数字,"category":"原始分类","account":"账户名","description":"描述","type":"expense/income"}。账户必选：微信, 支付宝, 余额宝, 花呗, 银行卡。' },
                        { role: 'user', content: text }
                    ],
                    response_format: { type: 'json_object' }
                })
            });
            const parsed = extractJSON((await dsRes.json()).choices[0].message.content);
            const cleanAmount = parseFloat(String(parsed.amount).replace(/[^\d.]/g, '')) || 0;
            const cleanAccount = mapAccount(parsed.account);

            if (cleanAccount === '余额宝') {
                const change = (parsed.type === 'income') ? cleanAmount : -cleanAmount;
                await env.DB.prepare("UPDATE funds SET principal = principal + ? WHERE fund_code = '161608'").bind(change).run();
            }

            await env.DB.prepare("INSERT INTO bills (amount, category, account, description, type) VALUES (?, ?, ?, ?, ?)")
                .bind(cleanAmount, parsed.category || "其它", cleanAccount, parsed.description || "", parsed.type || "expense").run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'PUT' && url.pathname.startsWith('/api/record/')) {
            const id = url.pathname.split('/').pop();
            const { text } = await request.json();
            const oldRecord = await env.DB.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'system', content: '修正账本。输出JSON。' }, { role: 'user', content: `原记录：${JSON.stringify(oldRecord)}。修正：${text}` }],
                    response_format: { type: 'json_object' }
                })
            });
            const parsed = extractJSON((await dsRes.json()).choices[0].message.content);
            await env.DB.prepare("UPDATE bills SET amount=?, category=?, account=?, description=?, type=? WHERE id=?")
                .bind(parseFloat(String(parsed.amount).replace(/[^\d.]/g, ''))||0, parsed.category, mapAccount(parsed.account), parsed.description, parsed.type, id).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE' && url.pathname.startsWith('/api/record/')) {
            await env.DB.prepare("DELETE FROM bills WHERE id = ?").bind(url.pathname.split('/').pop()).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：设置月度预算
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/budget/')) {
            const month = url.pathname.split('/').pop();
            const { amount } = await request.json();
            await env.DB.prepare("CREATE TABLE IF NOT EXISTS budgets (month TEXT PRIMARY KEY, amount REAL)").run();
            await env.DB.prepare("INSERT OR REPLACE INTO budgets (month, amount) VALUES (?, ?)").bind(month, Number(amount)).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：AI Reasoner 审计
        // ==========================================
        if (request.method === 'POST' && url.pathname === '/api/analyze') {
            const data = await request.json();
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'system', content: '财务审计官，输出深度Markdown。不输出任何代码块标识符。' }, { role: 'user', content: JSON.stringify(data) }] })
            });
            const res = await dsRes.json();
            return new Response(JSON.stringify({ analysis: res.choices[0].message.content }));
        }

        // ==========================================
        // API：基金调仓流水 (带有强制物理纠偏)
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/fund/')) {
            const code = url.pathname.split('/').pop();
            const { text, nav, date, baseName } = await request.json();
            
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: `解析基金调仓。净值:${nav}。返回JSON:{"amount":数字, "shares":数字}` }, 
                        { role: 'user', content: text }
                    ],
                    response_format: { type: 'json_object' }
                })
            });
            const parsed = extractJSON((await dsRes.json()).choices[0].message.content);
            let deltaAmount = parsed.amount || 0;
            let deltaShares = parsed.shares || 0;

            // 🔥 终极必杀技：如果用户意图是减仓，强制翻转符号，防 AI 脑残
            const isSelling = text.includes('卖') || text.includes('减') || text.includes('撤') || text.includes('出') || text.includes('赎');
            if (isSelling) {
                if (deltaAmount > 0) deltaAmount = -deltaAmount;
                if (deltaShares > 0) deltaShares = -deltaShares;
            }

            let finalName = baseName;
            if (date) finalName += `[起息:${date}]`;

            await env.DB.prepare("UPDATE funds SET shares=shares+?, principal=principal+?, fund_name=? WHERE fund_code=?")
                .bind(deltaShares, deltaAmount, finalName, code).run();
            await env.DB.prepare("INSERT INTO fund_logs (fund_code, fund_name, amount, shares, nav, target_date) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(code, baseName, deltaAmount, deltaShares, nav, date || '').run();

            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/api/fund_log/')) {
            const id = url.pathname.split('/').pop();
            const log = await env.DB.prepare("SELECT * FROM fund_logs WHERE id = ?").bind(id).first();
            if (log) {
                await env.DB.prepare("UPDATE funds SET shares=shares-?, principal=principal-? WHERE fund_code=?")
                    .bind(log.shares, log.amount, log.fund_code).run();
                await env.DB.prepare("DELETE FROM fund_logs WHERE id = ?").bind(id).run();
            }
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：账户调平
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/account/')) {
            const name = decodeURIComponent(url.pathname.split('/').pop());
            const { balance, limit } = await request.json();
            // 强力清洗：只提取数字和小数点，如果有文字统统干掉
            const cleanBalance = parseFloat(String(balance).replace(/[^\d.-]/g, '')) || 0;
            const cleanLimit = parseFloat(String(limit).replace(/[^\d.-]/g, '')) || 0;
            await env.DB.prepare("UPDATE accounts SET balance=?, credit_limit=? WHERE account_name=?").bind(cleanBalance, cleanLimit, name).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // 渲染层 (GET)
        // ==========================================
        if (request.method === 'GET') {
            const timeString = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', weekday: 'long'
            }).format(new Date());

            const currentMonth = new Date().toISOString().slice(0, 7);
            
            // 读取动态预算表
            let monthlyBudget = 1500; // 默认值
            try {
                const budgetRow = await env.DB.prepare("SELECT amount FROM budgets WHERE month = ?").bind(currentMonth).first();
                if (budgetRow) monthlyBudget = budgetRow.amount;
            } catch(e) {
                // 如果表不存在，静默处理（会在第一次修改预算时自动建表）
            }

            const { results: accBases } = await env.DB.prepare("SELECT * FROM accounts").all();
            let accounts = {}; 
            accBases.forEach(a => { 
                accounts[a.account_name] = { 
                    type: a.type, 
                    limit: Number(a.credit_limit) || 0, // 遇到 NULL 自动变成 0
                    balance: Number(a.balance) || 0     // 遇到 NULL 自动变成 0
                }; 
            });
            
            const { results: allBills } = await env.DB.prepare("SELECT * FROM bills ORDER BY id DESC").all();
            let spentThisMonth = 0; 

            allBills.forEach(b => {
                if (b.created_at && b.created_at.startsWith(currentMonth) && b.type === 'expense') spentThisMonth += b.amount;
                const acc = accounts[b.account] || { balance: 0, type: 'asset', limit: 0 };
                if (b.type === 'expense') { 
                    if (acc.type === 'liability') acc.balance += b.amount; else acc.balance -= b.amount; 
                } else if (b.type === 'income') { 
                    if (acc.type === 'liability') acc.balance -= b.amount; else acc.balance += b.amount; 
                }
            });

            const { results: rawFunds } = await env.DB.prepare("SELECT * FROM funds").all();
            let myFunds = rawFunds.filter(f => !f.fund_name.includes("广发创业板"));
            if (!myFunds.some(f => f.fund_code === '022435')) {
                myFunds.push({ fund_code: '022435', fund_name: '南方中证A500ETF联结C', principal: 0, shares: 0 });
            }

            let fundLogs = [];
            try {
                const logsQuery = await env.DB.prepare("SELECT * FROM fund_logs ORDER BY id DESC LIMIT 20").all();
                fundLogs = logsQuery.results;
            } catch(e) {}

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

                    let cleanName = fund.fund_name.replace(/\[起息:[^\]]+\]/g, '').split(' ')[0];
                    const dateMatches = fund.fund_name.match(/\[起息:([^\]]+)\]/g);
                    let isPending = false;
                    if (dateMatches) {
                        let lastDateStr = dateMatches[dateMatches.length - 1].replace('[起息:', '').replace(']', '');
                        let vDate = new Date(lastDateStr);
                        let today = new Date(); today.setHours(0,0,0,0);
                        if (today < vDate) isPending = true;
                    }

                    const currentValue = nav * fund.shares;
                    let totalPnl = isPending ? 0 : (currentValue - principal);
                    let dailyPnl = isPending ? 0 : (fund.shares * (nav - yest_nav));
                    
                    fundTotalAsset += currentValue; fundTotalPnl += totalPnl; fundTotalDailyPnl += dailyPnl;
                    fundDataForAI.push({ name: cleanName, pnl: totalPnl });

                    let statusBadge = isPending ? `<span style="background:#fff1f3; color:#ffb7c5; font-size:10px; padding:2px 6px; border-radius:10px; border:1px solid #ffb7c5; margin-left:6px;">起息待确认</span>` : '';

                    const itemHtml = `
                    <div class="fund-card">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <b style="font-size:14px;">${cleanName}${statusBadge}</b>
                            <b style="font-size:15px; color:#333;">¥${currentValue.toFixed(2)}</b>
                        </div>
                        <div style="font-size:11px; margin-top:8px; display:flex; justify-content:space-between; color:#666;">
                            <span>累计: <b style="color:${totalPnl>=0?'#e74c3c':'#2ecc71'}">${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}</b></span>
                            <span>今日: <b style="color:${dailyPnl>=0?'#e74c3c':'#2ecc71'}">${dailyPnl>=0?'+':''}${dailyPnl.toFixed(2)}</b></span>
                        </div>
                        <div style="text-align:right; margin-top:10px;">
                            <span class="btn-tiny" onclick="window.showFundModal('${fund.fund_code}', ${nav}, '${cleanName}')">🤖 调仓</span>
                        </div>
                    </div>`;
                    if (fund.fund_code === '161608') yuebaoHtml = itemHtml; else activeFundHtml += itemHtml;
                });
            } catch (e) {}

            let accountsHtml = ''; let huabeiHtml = ''; 
            let totalLiabilities = 0; let liquidAssets = 0;
            
            // 🔥 金额从大到小排序核心逻辑
            let sortedAccounts = Object.entries(accounts)
                .filter(([name]) => name !== '余额宝' && name !== '花呗')
                .sort((a, b) => b[1].balance - a[1].balance);

            sortedAccounts.forEach(([name, acc]) => {
                let rowHtml = '';
                if (acc.type === 'liability') { 
                    totalLiabilities += acc.balance;
                    rowHtml = `<div class="list-row"><span>${name}</span><div style="text-align:right;"><b style="color:#ff4d4f;">-¥${acc.balance.toFixed(2)}</b><br><small style="color:#999;font-size:10px;">可用 ¥${(acc.limit - acc.balance).toFixed(2)} / 总额 ¥${acc.limit}</small> <span class="btn-tiny" onclick="window.editAccount('${name}', ${acc.balance}, ${acc.limit})">🤖 调平</span></div></div>`;
                } else {
                    liquidAssets += acc.balance;
                    rowHtml = `<div class="list-row"><span>${name}</span><span><b>¥${acc.balance.toFixed(2)}</b> <span class="btn-tiny" onclick="window.editAccount('${name}', ${acc.balance}, ${acc.limit})">🤖 调平</span></span></div>`;
                }
                accountsHtml += rowHtml;
            });

            // 花呗专属沉底
            if (accounts['花呗']) {
                const hAcc = accounts['花呗'];
                totalLiabilities += hAcc.balance;
                huabeiHtml = `<div class="list-row"><span>花呗</span><div style="text-align:right;"><b style="color:#ff4d4f;">-¥${hAcc.balance.toFixed(2)}</b><br><small style="color:#999;font-size:10px;">可用 ¥${(hAcc.limit - hAcc.balance).toFixed(2)} / 总额 ¥${hAcc.limit}</small> <span class="btn-tiny" onclick="window.editAccount('花呗', ${hAcc.balance}, ${hAcc.limit})">🤖 调平</span></div></div>`;
            }
            accountsHtml += huabeiHtml;

            const GRAND_TOTAL = liquidAssets + fundTotalAsset - totalLiabilities;
            const remaining = monthlyBudget - spentThisMonth;
            const finalReport = { budget: monthlyBudget, spent: spentThisMonth, assets: GRAND_TOTAL, funds: fundDataForAI };

            return new Response(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>1nuo 财富中枢 V1.2</title>
                <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
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
                    .ai-box { background:rgba(255,255,255,0.9); border-radius:20px; padding:18px; margin-top:10px; font-size:14px; border: 1px dashed #ffb7c5; color:#444; line-height:1.7; overflow-x: auto; }
                    .ai-box h3, .ai-box h4 { margin: 12px 0 8px 0; color: #ff8da1; }
                    .ai-box ul { padding-left: 20px; margin: 8px 0; }
                    .ai-box li { margin-bottom: 5px; }
                    .ai-box strong { color: #ff6b81; }
                </style>
            </head>
            <body>
            <div class="container">
                <div style="grid-column: 1 / -1; text-align:center; color:#ff8da1; font-weight:bold; font-size:14px; margin-bottom:-5px;">
                    📅 ${timeString}
                </div>

                <div class="card" style="background:linear-gradient(90deg, #ffb7c5, #fecfef); color:white; grid-column: 1 / -1;">
                    <div style="opacity:0.9; font-size:13px;">动态净资产总额</div>
                    <div class="big-num" style="color:white;">¥${GRAND_TOTAL.toFixed(2)}</div>
                    <div style="font-size:12px; opacity:0.9;">✨ 累计盈亏: ${fundTotalPnl.toFixed(2)} | 今日: ${fundTotalDailyPnl.toFixed(2)}</div>
                </div>

                <div class="card">
                    <div class="card-header">AI 快速记账</div>
                    <textarea id="recordInput" placeholder="描述开销，如：王者充值50微信付..."></textarea>
                    <button id="recordBtn" onclick="window.submitRecord()">立即入账</button>
                    <div style="margin-top:20px; font-size:14px;">本月 (${currentMonth}) 剩余预算: 
                        <b style="color:#ffb7c5; cursor:pointer;" onclick="window.setMonthlyBudget('${currentMonth}', ${monthlyBudget})">¥${remaining.toFixed(2)} ✏️</b>
                        <br><small style="color:#999;">点击铅笔修改本月设定额度 (当前: ¥${monthlyBudget})</small>
                    </div>
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
                    <div class="card-header">📈 投资雷达</div>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">${activeFundHtml}</div>
                </div>

                <div class="card" style="grid-column: 1 / -1;">
                    <div class="card-header">📝 基金调仓流水 (支持单笔撤销)</div>
                    ${fundLogs.length === 0 ? '<small style="color:#999;">暂无调仓记录，新调仓后会显示在这里</small>' : fundLogs.map(l => `
                    <div class="bill-item">
                        <div style="flex:1;">
                            <b>${l.fund_name}</b> 
                            <span style="font-size:11px;color:#999;margin-left:5px;">净值:${l.nav} ${l.target_date ? '| 起息:'+l.target_date : ''}</span><br>
                            <small style="color:#aaa;">${new Date(new Date(l.created_at).getTime() + 8*60*60*1000).toLocaleString('zh-CN')}</small>
                        </div>
                        <div style="text-align:right;">
                            <b style="color:${l.amount >= 0 ? '#e74c3c' : '#2ecc71'}">${l.amount >= 0 ? '+' : ''}${l.amount.toFixed(2)} 元</b><br>
                            <small style="color:#666;">${l.shares >= 0 ? '+' : ''}${l.shares.toFixed(4)} 份</small>
                            <small onclick="window.undoFundLog(${l.id})" style="color:#ccc; cursor:pointer; margin-left:5px;">[撤销]</small>
                        </div>
                    </div>
                    `).join('')}
                </div>

                <div class="card" style="grid-column: 1 / -1;">
                    <div class="card-header" style="color:#ffb7c5;">🧠 AI Reasoner 财务审计 
                        <button onclick="window.runAudit()" id="auditBtn" style="width:auto; padding:4px 15px; margin:0; float:right; font-size:12px;">一键审计</button>
                    </div>
                    <div id="aiRes" class="ai-box">点击获取由 R1 模型驱动的深度审计报告...</div>
                </div>
            </div>

            <div id="fundModalOverlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:999; backdrop-filter:blur(2px);" onclick="window.closeModal()"></div>
            <div id="fundModal" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:white; padding:25px; border-radius:24px; box-shadow:0 10px 40px rgba(255, 182, 193, 0.3); z-index:1000; width:80%; max-width:300px;">
                <div style="font-weight:bold; font-size:16px; margin-bottom:15px; color:#ffb7c5; display:flex; justify-content:space-between;">
                    <span>🤖 基金调仓指令</span>
                    <span onclick="window.closeModal()" style="color:#ccc; cursor:pointer;">✖</span>
                </div>
                <textarea id="fundPromptText" placeholder="告诉AI你的操作，例如：今日减仓1000元" style="width:100%; height:80px; margin-bottom:15px;"></textarea>
                <div style="font-size:12px; color:#999; margin-bottom:8px;">📅 指定起息日（选填）</div>
                <input type="date" id="fundDateInput" style="width:100%; padding:12px; border:2px solid #fff1f3; border-radius:16px; box-sizing:border-box; margin-bottom:20px; outline:none; font-family:inherit; color:#555;">
                <button onclick="window.submitFundEdit()" id="modalSubmitBtn" style="margin-top:0;">执行调仓</button>
            </div>

            <script>
                window.auditData = ${JSON.stringify(finalReport)};
                window.currentEditFund = null; 

                // 预算修改
                window.setMonthlyBudget = async function(month, currentAmt) {
                    const amt = prompt('请输入本月总预算金额 (如果是0则填0)：', currentAmt);
                    if (amt !== null && !isNaN(amt) && amt.trim() !== '') {
                        document.body.style.opacity = '0.5';
                        await fetch('/api/budget/'+month, { method: 'PUT', body: JSON.stringify({ amount: amt }) });
                        location.reload();
                    }
                };

                // 调仓 UI
                window.showFundModal = function(code, nav, baseName) {
                    window.currentEditFund = { code, nav, baseName };
                    document.getElementById('fundModalOverlay').style.display = 'block';
                    document.getElementById('fundModal').style.display = 'block';
                    document.getElementById('fundPromptText').value = '';
                    document.getElementById('fundDateInput').value = new Date().toISOString().split('T')[0];
                };

                window.closeModal = function() {
                    document.getElementById('fundModalOverlay').style.display = 'none';
                    document.getElementById('fundModal').style.display = 'none';
                };

                window.submitFundEdit = async function() {
                    const text = document.getElementById('fundPromptText').value;
                    const date = document.getElementById('fundDateInput').value;
                    if (!text) { alert('请输入调仓指令呀！'); return; }

                    const btn = document.getElementById('modalSubmitBtn');
                    btn.innerText = 'AI正在计算...';
                    document.getElementById('fundModal').style.opacity = '0.7';

                    const { code, nav, baseName } = window.currentEditFund;
                    try {
                        await fetch('/api/fund/'+code, { method:'PUT', body:JSON.stringify({text, nav, date, baseName}) });
                        location.reload(); 
                    } catch(e) {
                        alert('调仓失败，请检查网络');
                        btn.innerText = '执行调仓';
                        document.getElementById('fundModal').style.opacity = '1';
                    }
                };

                window.undoFundLog = async function(id) {
                    if(confirm('确定要撤销这笔基金操作吗？')) { 
                        document.body.style.opacity = '0.5';
                        await fetch('/api/fund_log/'+id, {method:'DELETE'}); 
                        location.reload(); 
                    }
                };

                window.submitRecord = async function() {
                    const btn = document.getElementById('recordBtn'); const text = document.getElementById('recordInput').value;
                    if(!text) return; btn.innerText = '解析入库中...';
                    try {
                        const res = await fetch('/api/record', { method: 'POST', body: JSON.stringify({ text }) });
                        if(res.ok) location.reload(); else throw new Error();
                    } catch(e) { alert('记账失败'); btn.innerText = '立即入账'; }
                };

                // 审计 Markdown 修复
                window.runAudit = async function() {
                    const btn = document.getElementById('auditBtn'); const box = document.getElementById('aiRes');
                    btn.innerText = '逻辑推理中...'; box.innerText = 'AI 正在调取全量流水并深度思考...';
                    try {
                        const res = await fetch('/api/analyze', { method: 'POST', body: JSON.stringify(window.auditData) });
                        const data = await res.json();
                        
                        // 剃掉 R1 的 <think> 思考过程标签，避免搞崩渲染
                        let pureMarkdown = data.analysis || '';
                        pureMarkdown = pureMarkdown.replace(/<think>[\\s\\S]*?<\\/think>/gi, '');
                        
                        box.innerHTML = marked.parse(pureMarkdown);
                    } catch(e) { 
                        box.innerText = '审计超时或解析失败，建议刷新重试'; 
                        console.error(e);
                    }
                    finally { btn.innerText = '一键审计'; }
                };

                window.editBill = async function(id, old) {
                    const text = prompt('全量修正该账单(例如：其实是微信付了50元吃火锅)：', old);
                    if(text) { document.body.style.opacity = '0.5'; await fetch('/api/record/'+id, { method: 'PUT', body: JSON.stringify({ text }) }); location.reload(); }
                };

                window.editAccount = async function(name, b, l) {
                    const nb = prompt('修改【'+name+'】当前余额/已用:', b);
                    const nl = prompt('修改【'+name+'】总额度:', l);
                    if(nb !== null && nl !== null) { 
                        document.body.style.opacity = '0.5'; 
                        await fetch('/api/account/'+encodeURIComponent(name), {method:'PUT', body:JSON.stringify({balance: nb, limit: nl})}); 
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