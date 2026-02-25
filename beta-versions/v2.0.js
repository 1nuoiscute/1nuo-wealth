/**
 * 1nuo 财富中枢 V2.0 (V1.3 功能完整保留 + 多用户隔离版)
 */

function extractJSON(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const jsonStr = text.substring(start, end + 1).replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
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

// --- V2.0 新增：用户身份获取 ---
async function getCurrentUser(request, env) {
  const cookie = request.headers.get('Cookie');
  if (!cookie || !cookie.includes('auth_token=')) return null;
  const token = cookie.split('auth_token=')[1].split(';')[0];
  const session = await env.DB.prepare("SELECT user_id FROM sessions WHERE token = ?").bind(token).first();
  if (!session) return null;
  return session.user_id;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // V2.0 新增：公开认证接口 (登录/注册/退出)
    // ==========================================
    
    // 登录 (明文比对，确保成功)
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const { username, password } = await request.json();
        const user = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND password = ?").bind(username, password).first();
        if (!user) return new Response(JSON.stringify({ success: false, msg: "账号或密码错误" }), { status: 401 });
        const token = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").bind(token, user.id).run();
        return new Response(JSON.stringify({ success: true }), { headers: { 'Set-Cookie': `auth_token=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax` } });
    }

    // 注册 (自动初始化账户)
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        const { username, password } = await request.json();
        try {
            const res = await env.DB.prepare("INSERT INTO users (username, password) VALUES (?, ?)").bind(username, password).run();
            const newUserId = res.meta.last_row_id;
            // 初始化默认账户
            const defaultAccounts = ['微信', '支付宝', '银行卡', '现金', '花呗'];
            const stmt = env.DB.prepare("INSERT INTO accounts (account_name, type, balance, credit_limit, user_id) VALUES (?, ?, 0, ?, ?)");
            await env.DB.batch(defaultAccounts.map(name => stmt.bind(name, name==='花呗'?'liability':'asset', name==='花呗'?2000:0, newUserId)));
            return new Response(JSON.stringify({ success: true }));
        } catch(e) { return new Response(JSON.stringify({ success: false, msg: "用户已存在" }), { status: 400 }); }
    }

    // 退出
    if (url.pathname === '/api/auth/logout') {
        const cookie = request.headers.get('Cookie');
        if (cookie) {
            const token = cookie.split('auth_token=')[1].split(';')[0];
            await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        }
        return new Response("Logged out", { headers: { 'Set-Cookie': `auth_token=; Path=/; Max-Age=0`, 'Location': '/' }, status: 302 });
    }

    // ==========================================
    // V2.0 全局守卫：未登录拦截
    // ==========================================
    const userID = await getCurrentUser(request, env);
    
    // 未登录显示登录页 (保持粉色风格)
    if (!userID) {
        return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>1nuo 财富中枢 - 登录</title><style>body{font-family:-apple-system;background:linear-gradient(135deg,#fff5f7 0%,#ffffff 100%);display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.card{background:rgba(255,255,255,0.9);backdrop-filter:blur(10px);padding:30px;border-radius:24px;box-shadow:0 8px 30px rgba(255,182,193,0.2);width:300px;text-align:center;border:1px solid #fff1f3;}input{width:100%;padding:12px;margin:10px 0;border:2px solid #fff1f3;border-radius:16px;box-sizing:border-box;outline:none;background:#fff;}button{width:100%;padding:12px;background:#ffb7c5;color:white;border:none;border-radius:16px;font-weight:bold;cursor:pointer;margin-top:10px;}.toggle{color:#ffb7c5;font-size:12px;margin-top:15px;cursor:pointer;}</style></head><body><div class="card"><h2 style="color:#ffb7c5;margin-top:0;">🔐 欢迎回家</h2><input id="u" placeholder="用户名"><input id="p" type="password" placeholder="密码"><button onclick="auth()">登 录</button><div class="toggle" onclick="toggle()">没有账号？点此注册</div></div><script>let isReg=false;function toggle(){isReg=!isReg;document.querySelector('h2').innerText=isReg?'📝 注册新账号':'🔐 欢迎回家';document.querySelector('button').innerText=isReg?'注 册':'登 录';document.querySelector('.toggle').innerText=isReg?'已有账号？去登录':'没有账号？点此注册';}async function auth(){const u=document.getElementById('u').value,p=document.getElementById('p').value;if(!u||!p)return alert('请填写完整');const ep=isReg?'/api/auth/register':'/api/auth/login';const res=await fetch(ep,{method:'POST',body:JSON.stringify({username:u,password:p})});const d=await res.json();if(d.success){if(isReg){alert('注册成功，请登录');toggle();}else{location.reload();}}else{alert(d.msg||'失败');}}</script></body></html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    try {
        // ==========================================
        // API：日常记账 (已注入 user_id)
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
                // 🔒 注入 user_id
                await env.DB.prepare("UPDATE funds SET principal = principal + ? WHERE fund_code = '161608' AND user_id = ?").bind(change, userID).run();
            }

            // 🔒 注入 user_id
            await env.DB.prepare("INSERT INTO bills (amount, category, account, description, type, user_id) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(cleanAmount, parsed.category || "其它", cleanAccount, parsed.description || "", parsed.type || "expense", userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'PUT' && url.pathname.startsWith('/api/record/')) {
            const id = url.pathname.split('/').pop();
            const { text } = await request.json();
            // 🔒 校验 user_id
            const oldRecord = await env.DB.prepare("SELECT * FROM bills WHERE id = ? AND user_id = ?").bind(id, userID).first();
            if (!oldRecord) return new Response("Forbidden", {status:403});

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
            // 🔒 注入 user_id
            await env.DB.prepare("UPDATE bills SET amount=?, category=?, account=?, description=?, type=? WHERE id=? AND user_id=?")
                .bind(parseFloat(String(parsed.amount).replace(/[^\d.]/g, ''))||0, parsed.category, mapAccount(parsed.account), parsed.description, parsed.type, id, userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/api/record/')) {
            const id = url.pathname.split('/').pop();
            // 🔒 注入 user_id
            await env.DB.prepare("DELETE FROM bills WHERE id = ? AND user_id = ?").bind(id, userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：设置月度预算 (已注入 user_id)
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/budget/')) {
            const month = url.pathname.split('/').pop();
            const { amount } = await request.json();
            await env.DB.prepare("CREATE TABLE IF NOT EXISTS budgets (month TEXT PRIMARY KEY, amount REAL, user_id INTEGER DEFAULT 1)").run();
            // 🔒 注入 user_id，改用 DELETE+INSERT 避免 Upsert 兼容性问题
            await env.DB.prepare("DELETE FROM budgets WHERE month = ? AND user_id = ?").bind(month, userID).run();
            await env.DB.prepare("INSERT INTO budgets (month, amount, user_id) VALUES (?, ?, ?)").bind(month, Number(amount), userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：前台动态增删基金 (已注入 user_id)
        // ==========================================
        if (request.method === 'POST' && url.pathname === '/api/manage_fund') {
            const { code, name } = await request.json();
            // 🔒 注入 user_id
            await env.DB.prepare("INSERT OR IGNORE INTO funds (fund_code, fund_name, principal, shares, user_id) VALUES (?, ?, 0, 0, ?)").bind(code, name, userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/api/manage_fund/')) {
            const code = url.pathname.split('/').pop();
            // 🔒 注入 user_id
            await env.DB.prepare("DELETE FROM funds WHERE fund_code = ? AND user_id = ?").bind(code, userID).run();
            await env.DB.prepare("DELETE FROM fund_logs WHERE fund_code = ? AND user_id = ?").bind(code, userID).run();
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
        // API：基金调仓流水 (已注入 user_id)
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

            const isSelling = text.includes('卖') || text.includes('减') || text.includes('撤') || text.includes('出') || text.includes('赎');
            if (isSelling) {
                if (deltaAmount > 0) deltaAmount = -deltaAmount;
                if (deltaShares > 0) deltaShares = -deltaShares;
            }

            let finalName = baseName;
            if (date) finalName += `[起息:${date}]`;

            // 🔒 注入 user_id
            await env.DB.prepare("UPDATE funds SET shares=shares+?, principal=principal+?, fund_name=? WHERE fund_code=? AND user_id=?")
                .bind(deltaShares, deltaAmount, finalName, code, userID).run();
            await env.DB.prepare("INSERT INTO fund_logs (fund_code, fund_name, amount, shares, nav, target_date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(code, baseName, deltaAmount, deltaShares, nav, date || '', userID).run();

            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/api/fund_log/')) {
            const id = url.pathname.split('/').pop();
            // 🔒 校验 user_id
            const log = await env.DB.prepare("SELECT * FROM fund_logs WHERE id = ? AND user_id = ?").bind(id, userID).first();
            if (log) {
                await env.DB.prepare("UPDATE funds SET shares=shares-?, principal=principal-? WHERE fund_code=? AND user_id=?")
                    .bind(log.shares, log.amount, log.fund_code, userID).run();
                await env.DB.prepare("DELETE FROM fund_logs WHERE id = ? AND user_id = ?").bind(id, userID).run();
            }
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // API：账户调平 (已注入 user_id)
        // ==========================================
        if (request.method === 'PUT' && url.pathname.startsWith('/api/account/')) {
            const name = decodeURIComponent(url.pathname.split('/').pop());
            const { balance, limit } = await request.json();
            const cleanBalance = parseFloat(String(balance).replace(/[^\d.-]/g, '')) || 0;
            const cleanLimit = parseFloat(String(limit).replace(/[^\d.-]/g, '')) || 0;
            // 🔒 注入 user_id
            await env.DB.prepare("UPDATE accounts SET balance=?, credit_limit=? WHERE account_name=? AND user_id=?").bind(cleanBalance, cleanLimit, name, userID).run();
            return new Response(JSON.stringify({ success: true }));
        }

        // ==========================================
        // 渲染层 (GET) (已注入 user_id 筛选)
        // ==========================================
        if (request.method === 'GET') {
            const timeString = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', weekday: 'long'
            }).format(new Date());

            const currentMonth = new Date().toISOString().slice(0, 7);
            
            let monthlyBudget = -1; 
            try {
                // 🔒 筛选 user_id
                const budgetRow = await env.DB.prepare("SELECT amount FROM budgets WHERE month = ? AND user_id = ?").bind(currentMonth, userID).first();
                if (budgetRow) monthlyBudget = budgetRow.amount;
            } catch(e) {}

            // 🔒 筛选 user_id
            const { results: accBases } = await env.DB.prepare("SELECT * FROM accounts WHERE user_id = ?").bind(userID).all();
            let accounts = {}; 
            accBases.forEach(a => { 
                accounts[a.account_name] = { 
                    type: a.type, 
                    limit: Number(a.credit_limit) || 0,
                    balance: Number(a.balance) || 0    
                }; 
            });
            
            // 🔒 筛选 user_id
            const { results: allBills } = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? ORDER BY id DESC").bind(userID).all();
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

            // 🔒 筛选 user_id
            const { results: myFunds } = await env.DB.prepare("SELECT * FROM funds WHERE user_id = ?").bind(userID).all();

            let fundLogs = [];
            try {
                // 🔒 筛选 user_id
                const logsQuery = await env.DB.prepare("SELECT * FROM fund_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50").bind(userID).all();
                fundLogs = logsQuery.results;
            } catch(e) {}
            
            const uniqueFunds = [...new Set(fundLogs.map(l => l.fund_name))];

            let fundTotalAsset = 0; let fundTotalPnl = 0; let fundTotalDailyPnl = 0; let fundTotalPrincipal = 0;
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
                    fundTotalPrincipal += principal;
                    fundDataForAI.push({ name: cleanName, pnl: totalPnl });

                    let statusBadge = isPending ? `<span style="background:#fff1f3; color:#ffb7c5; font-size:10px; padding:2px 6px; border-radius:10px; border:1px solid #ffb7c5; margin-left:6px;">起息待确认</span>` : '';

                    let deleteBtn = fund.fund_code !== '161608' ? `<span class="btn-tiny" style="color:#ccc; border-color:#ccc; margin-right:4px;" onclick="window.removeFund('${fund.fund_code}', '${cleanName}')">🗑️ 移除</span>` : '';

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
                            ${deleteBtn}
                            <span class="btn-tiny" onclick="window.showFundModal('${fund.fund_code}', ${nav}, '${cleanName}')">🤖 调仓</span>
                        </div>
                    </div>`;
                    if (fund.fund_code === '161608') yuebaoHtml = itemHtml; else activeFundHtml += itemHtml;
                });
            } catch (e) {}
            
            let pnlPercentStr = '0.00%';
            if (fundTotalPrincipal > 0) {
                let pct = (fundTotalPnl / fundTotalPrincipal) * 100;
                pnlPercentStr = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
            }

            let accountsHtml = ''; let huabeiHtml = ''; 
            let totalLiabilities = 0; let liquidAssets = 0;
            
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

            if (accounts['花呗']) {
                const hAcc = accounts['花呗'];
                totalLiabilities += hAcc.balance;
                huabeiHtml = `<div class="list-row"><span>花呗</span><div style="text-align:right;"><b style="color:#ff4d4f;">-¥${hAcc.balance.toFixed(2)}</b><br><small style="color:#999;font-size:10px;">可用 ¥${(hAcc.limit - hAcc.balance).toFixed(2)} / 总额 ¥${hAcc.limit}</small> <span class="btn-tiny" onclick="window.editAccount('花呗', ${hAcc.balance}, ${hAcc.limit})">🤖 调平</span></div></div>`;
            }
            accountsHtml += huabeiHtml;

            const GRAND_TOTAL = liquidAssets + fundTotalAsset - totalLiabilities;
            const finalReport = { budget: monthlyBudget, spent: spentThisMonth, assets: GRAND_TOTAL, funds: fundDataForAI };

            return new Response(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>1nuo 财富中枢 V2.0</title>
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
                <div style="grid-column: 1 / -1; display:flex; justify-content:space-between; align-items:center; color:#ff8da1; font-weight:bold; font-size:14px; margin-bottom:-5px;">
                    <span>📅 ${timeString}</span>
                    <a href="/api/auth/logout" style="color:#aaa; text-decoration:none; font-size:12px; border:1px solid #eee; padding:2px 8px; border-radius:10px;">退出登录</a>
                </div>

                <div class="card" style="background:linear-gradient(90deg, #ffb7c5, #fecfef); color:white; grid-column: 1 / -1;">
                    <div style="opacity:0.9; font-size:13px;">动态净资产总额</div>
                    <div class="big-num" style="color:white;">¥${GRAND_TOTAL.toFixed(2)}</div>
                    <div style="font-size:12px; opacity:0.9;">✨ 累计盈亏: ${fundTotalPnl.toFixed(2)} | 今日: ${fundTotalDailyPnl.toFixed(2)} | 收益率: ${pnlPercentStr}</div>
                </div>

                <div class="card">
                    <div class="card-header">AI 快速记账</div>
                    <textarea id="recordInput" placeholder="描述开销，如：王者充值50微信付..."></textarea>
                    <button id="recordBtn" onclick="window.submitRecord()">立即入账</button>
                    <div style="margin-top:20px; font-size:14px;">本月 (${currentMonth}) 剩余预算: 
                        <b style="color:#ffb7c5; cursor:pointer;" onclick="window.setMonthlyBudget('${currentMonth}', ${monthlyBudget})">
                            ${monthlyBudget === -1 ? '不设预算' : '¥' + (monthlyBudget - spentThisMonth).toFixed(2)} ✏️
                        </b>
                        <br><small style="color:#999;">点击铅笔设定额度 (当前: ${monthlyBudget === -1 ? '无预算' : '¥' + monthlyBudget})</small>
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
                    <div class="card-header" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>📈 投资雷达</span>
                        <span style="font-size:12px; font-weight:normal; color:#ffb7c5; cursor:pointer; border:1px solid #ffb7c5; padding:2px 8px; border-radius:12px;" onclick="window.addNewFund()">+ 新增基金</span>
                    </div>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">${activeFundHtml}</div>
                </div>

                <div class="card" style="grid-column: 1 / -1;">
                    <div class="card-header" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>📝 基金调仓流水 (支持单笔撤销)</span>
                        ${uniqueFunds.length > 0 ? `
                        <select id="fundLogFilter" onchange="window.filterFundLogs()" style="border-radius:8px; border:1px solid #fff1f3; padding:2px 5px; color:#666; font-size:12px; outline:none; background:white;">
                            <option value="all">全部基金</option>
                            ${uniqueFunds.map(f => `<option value="${f}">${f}</option>`).join('')}
                        </select>
                        ` : ''}
                    </div>
                    ${fundLogs.length === 0 ? '<small style="color:#999;">暂无调仓记录，新调仓后会显示在这里</small>' : fundLogs.map(l => `
                    <div class="bill-item log-item" data-fund-name="${l.fund_name}">
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

                // V1.3: 动态增加基金
                window.addNewFund = async function() {
                    const code = prompt('请输入新基金的代码 (例如: 008507)：');
                    if (!code || !code.trim()) return;
                    const name = prompt('请输入新基金的名称 (例如: 华夏人工智能)：');
                    if (!name || !name.trim()) return;

                    document.body.style.opacity = '0.5';
                    try {
                        await fetch('/api/manage_fund', { method: 'POST', body: JSON.stringify({ code: code.trim(), name: name.trim() }) });
                        location.reload();
                    } catch(e) { alert('添加失败'); document.body.style.opacity = '1'; }
                };

                // V1.3: 动态移除基金
                window.removeFund = async function(code, name) {
                    if (confirm('确定要彻底移除【' + name + '】吗？\\n注意：移除后，该基金的资产和所有相关的调仓流水将被清空！')) {
                        document.body.style.opacity = '0.5';
                        await fetch('/api/manage_fund/' + code, { method: 'DELETE' });
                        location.reload();
                    }
                };

                window.setMonthlyBudget = async function(month, currentAmt) {
                    const promptText = '请输入本月总预算金额\\n(输入 -1 或留空表示不设预算)：';
                    const defaultVal = currentAmt === -1 ? '' : currentAmt;
                    const amt = prompt(promptText, defaultVal);
                    if (amt !== null) {
                        const finalAmt = (amt.trim() === '' || isNaN(amt) || Number(amt) < 0) ? -1 : Number(amt);
                        document.body.style.opacity = '0.5';
                        await fetch('/api/budget/'+month, { method: 'PUT', body: JSON.stringify({ amount: finalAmt }) });
                        location.reload();
                    }
                };

                window.filterFundLogs = function() {
                    const selected = document.getElementById('fundLogFilter').value;
                    const items = document.querySelectorAll('.log-item');
                    items.forEach(item => {
                        if (selected === 'all' || item.getAttribute('data-fund-name') === selected) {
                            item.style.display = 'flex';
                        } else {
                            item.style.display = 'none';
                        }
                    });
                };

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

                window.runAudit = async function() {
                    const btn = document.getElementById('auditBtn'); const box = document.getElementById('aiRes');
                    btn.innerText = '逻辑推理中...'; box.innerText = 'AI 正在调取全量流水并深度思考...';
                    try {
                        const res = await fetch('/api/analyze', { method: 'POST', body: JSON.stringify(window.auditData) });
                        const data = await res.json();
                        
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