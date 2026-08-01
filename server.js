const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.jsonl');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============== 工具函数 ==============

// 1×1 透明 GIF (base64 编码, 43 字节)
const PIXEL_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
);

// 解析 User-Agent 判断设备类型
function parseDevice(ua) {
    if (!ua) return 'unknown';
    const u = ua.toLowerCase();
    if (/iphone|ipod/.test(u)) return 'iPhone';
    if (/ipad/.test(u)) return 'iPad';
    if (/android.*mobile/.test(u)) return 'Android手机';
    if (/android/.test(u)) return 'Android平板';
    if (/windows phone|iemobile/.test(u)) return 'Windows Phone';
    if (/macintosh|mac os x/.test(u)) return 'Mac';
    if (/windows/.test(u)) return 'Windows';
    if (/linux/.test(u)) return 'Linux';
    return '其他';
}

// 解析 User-Agent 判断浏览器
function parseBrowser(ua) {
    if (!ua) return 'unknown';
    const u = ua.toLowerCase();
    if (/micromessenger/.test(u)) return '微信内置';
    if (/wechat/.test(u)) return '微信内置';
    if (/qq\//.test(u)) return 'QQ浏览器';
    if (/alipay/.test(u)) return '支付宝';
    if (/safari/.test(u) && !/chrome/.test(u)) return 'Safari';
    if (/edg/.test(u)) return 'Edge';
    if (/chrome/.test(u)) return 'Chrome';
    if (/firefox/.test(u)) return 'Firefox';
    return '其他';
}

// 解析 referrer 判断来源渠道
function parseChannel(ref) {
    if (!ref || ref === '' || ref === '-') return '直接访问';
    if (ref.includes('weixin') || ref.includes('wechat')) return '微信';
    if (ref.includes('mp.weixin.qq.com')) return '公众号';
    if (ref.includes('zhihu')) return '知乎';
    if (ref.includes('weibo')) return '微博';
    if (ref.includes('baidu')) return '百度搜索';
    if (ref.includes('google')) return 'Google搜索';
    if (ref.includes('douyin')) return '抖音';
    if (ref.includes('xiaohongshu')) return '小红书';
    try {
        const url = new URL(ref);
        return url.hostname;
    } catch (e) {
        return ref.substring(0, 30);
    }
}

// 通过免费 API 查询 IP 归属地（带缓存）
const geoCache = new Map();
const GEO_CACHE_MAX = 5000;

async function lookupGeo(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:')) {
        return { country: '本地', region: '', city: '' };
    }
    // 清理 IPv6 前缀
    const cleanIP = ip.replace(/^::ffff:/, '');
    if (cleanIP.startsWith('10.') || cleanIP.startsWith('172.') || cleanIP.startsWith('192.168.')) {
        return { country: '内网', region: '', city: '' };
    }
    if (geoCache.has(cleanIP)) {
        return geoCache.get(cleanIP);
    }
    try {
        // 使用 ip-api.com 免费 API（每分钟45次，不需要 key）
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch(`http://ip-api.com/json/${cleanIP}?lang=zh-CN&fields=status,country,regionName,city`, {
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (resp.ok) {
            const data = await resp.json();
            if (data.status === 'success') {
                const geo = {
                    country: data.country || '',
                    region: data.regionName || '',
                    city: data.city || ''
                };
                // 缓存
                if (geoCache.size < GEO_CACHE_MAX) {
                    geoCache.set(cleanIP, geo);
                }
                return geo;
            }
        }
    } catch (e) {
        // 超时或网络错误，忽略
    }
    const fallback = { country: '', region: '', city: '' };
    if (geoCache.size < GEO_CACHE_MAX) {
        geoCache.set(cleanIP, fallback);
    }
    return fallback;
}

// ============== 路由 ==============

// 首页重定向到 index.html
app.get('/', (req, res, next) => {
    // Express static 会自动处理 index.html
    next();
});

// 追踪像素端点
app.get('/pixel', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.ip
        || req.socket?.remoteAddress
        || '';
    const ua = req.headers['user-agent'] || '';
    
    // 异步查询 IP 归属地
    const geo = await lookupGeo(ip);

    const entry = {
        t: new Date().toISOString(),
        ip: ip.replace(/^::ffff:/, ''),
        c: geo.country,
        r: geo.region,
        ci: geo.city,
        d: parseDevice(ua),
        b: parseBrowser(ua),
        ch: parseChannel(req.headers['referer'] || req.query.ref || ''),
        p: req.query.p || '/'
    };

    // 追加写入 JSONL
    fs.appendFileSync(STATS_FILE, JSON.stringify(entry) + '\n');

    // 返回透明像素
    res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': PIXEL_GIF.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(PIXEL_GIF);
});

// 统计 API
app.get('/api/stats', (req, res) => {
    let entries = [];
    if (fs.existsSync(STATS_FILE)) {
        try {
            const data = fs.readFileSync(STATS_FILE, 'utf-8');
            entries = data.trim().split('\n').filter(Boolean).map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(Boolean);
        } catch (e) {
            entries = [];
        }
    }

    // --- 聚合计算 ---

    // 总 PV
    const totalPV = entries.length;

    // 独立 IP
    const uniqueIPs = new Set(entries.map(e => e.ip)).size;

    // 各页面 PV
    const pages = {};
    entries.forEach(e => {
        const p = e.p || '/';
        pages[p] = (pages[p] || 0) + 1;
    });

    // 城市分布 (top 15)
    const cities = {};
    entries.forEach(e => {
        const city = e.ci || '';
        const region = e.r || '';
        const country = e.c || '';
        let label;
        if (city && country) label = `${city}, ${country}`;
        else if (region && country) label = `${region}, ${country}`;
        else if (country) label = country;
        else label = '未知';
        cities[label] = (cities[label] || 0) + 1;
    });
    const topCities = Object.entries(cities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

    // 设备分布
    const devices = {};
    entries.forEach(e => {
        const d = e.d || 'unknown';
        devices[d] = (devices[d] || 0) + 1;
    });

    // 浏览器分布
    const browsers = {};
    entries.forEach(e => {
        const b = e.b || 'unknown';
        browsers[b] = (browsers[b] || 0) + 1;
    });

    // 来源渠道分布
    const channels = {};
    entries.forEach(e => {
        const ch = e.ch || '直接访问';
        channels[ch] = (channels[ch] || 0) + 1;
    });

    // 24 小时分布
    const hourly = new Array(24).fill(0);
    entries.forEach(e => {
        const h = new Date(e.t).getHours();
        if (h >= 0 && h < 24) hourly[h]++;
    });

    // 最近 30 条记录（倒序）
    const recent = entries.slice(-30).reverse().map(e => ({
        time: e.t,
        page: e.p,
        device: e.d,
        browser: e.b,
        channel: e.ch,
        location: [e.ci, e.r, e.c].filter(Boolean).join(', ') || '未知'
    }));

    res.json({
        totalPV,
        uniqueIPs,
        pages,
        topCities,
        devices,
        browsers,
        channels,
        hourly,
        recent,
        lastUpdated: new Date().toISOString()
    });
});

// Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// 静态文件（放在路由之后，确保 /pixel 和 /api/stats 优先）
app.use(express.static(__dirname, {
    index: 'index.html',
    extensions: ['html']
}));

// 启动
app.listen(PORT, () => {
    console.log(`广谱站点已启动: http://localhost:${PORT}`);
    console.log(`数据面板: http://localhost:${PORT}/dashboard`);
});
