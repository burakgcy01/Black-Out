// AeroGrid: Void Survival — Multiplayer Server
// Node.js + ws  →  Replit'te çalıştırmak için:
//   package.json'a "ws" bağımlılığı ekle, ya da:  npm install ws
//   Replit'te main file olarak bu dosyayı seç

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// ─── HTTP: bo73.html ve statik dosyaları sun ─────────────────────────────────
const httpServer = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
        res.end(data);
    });
});

// ─── OYUN STATE ───────────────────────────────────────────────────────────────
const TICK_RATE = 20; // ms — 50 fps server tick

let nextId = 1;
const players   = new Map(); // id → { ws, state }
const worldGrid = new Map(); // "gx,gy" → cell  (shared world)
const chests    = new Map(); // id → chest
const worldItems= new Map(); // id → item
let nextChestId = 1;
let nextItemId  = 1;

// Başlangıç grid (0,0 merkezli 1 tile)
worldGrid.set('0,0', { color:'#2a3140', type:'normal', isWall:false });

// ─── YARDIMCI ─────────────────────────────────────────────────────────────────
function broadcast(msg, exceptId = null) {
    const raw = JSON.stringify(msg);
    for (const [id, p] of players) {
        if (id === exceptId) continue;
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
}
function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastAll(msg) { broadcast(msg, null); }

// ─── WebSocket SUNUCU ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    const id = nextId++;
    const state = {
        id,
        x: 0, y: 0, z: 0,
        facing: 0,
        health: 100,
        isDead: false,
        activeWeaponMode: null,
        handSlot1: null,
        handSlot2: null,
        hasArmor: false,
        currentWorld: 'game',
        isEating: false,
        attackTimer: 0,
        bowCharging: false,
        bowCharge: 0,
        name: `Oyuncu${id}`,
        color: `hsl(${(id * 137) % 360},70%,60%)`,
    };
    players.set(id, { ws, state });

    console.log(`[+] Oyuncu ${id} bağlandı. Toplam: ${players.size}`);

    // Yeni oyuncuya: kendi id, dünya durumu, diğer oyuncular
    send(ws, {
        type: 'INIT',
        id,
        grid: Object.fromEntries(worldGrid),
        chests: Object.fromEntries(
            [...chests.entries()].map(([k,v]) => [k, { ...v, items: v.items }])
        ),
        worldItems: Object.fromEntries(worldItems),
        players: [...players.values()]
            .filter(p => p.state.id !== id)
            .map(p => p.state),
    });

    // Diğerlerine: yeni oyuncu geldi
    broadcast({ type: 'PLAYER_JOIN', player: state }, id);

    // ── Mesaj handler ─────────────────────────────────────────────────────────
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // Pozisyon + state güncellemesi (her ~50ms client'tan gelir)
            case 'PLAYER_UPDATE': {
                const s = players.get(id)?.state;
                if (!s) break;
                Object.assign(s, {
                    x: msg.x, y: msg.y, z: msg.z,
                    facing: msg.facing,
                    health: msg.health,
                    isDead: msg.isDead,
                    activeWeaponMode: msg.activeWeaponMode,
                    handSlot1: msg.handSlot1,
                    handSlot2: msg.handSlot2,
                    hasArmor: msg.hasArmor,
                    currentWorld: msg.currentWorld,
                    isEating: msg.isEating,
                    attackTimer: msg.attackTimer,
                    bowCharging: msg.bowCharging,
                    bowCharge: msg.bowCharge,
                });
                // Başka oyunculara ilet (aynı world'da olanlar)
                broadcast({ type: 'PLAYER_UPDATE', ...s }, id);
                break;
            }

            // Grid tile ekleme/değiştirme
            case 'GRID_SET': {
                const { gx, gy, cell } = msg;
                const key = `${gx},${gy}`;
                if (cell === null) { worldGrid.delete(key); }
                else               { worldGrid.set(key, cell); }
                broadcast({ type: 'GRID_SET', gx, gy, cell }, id);
                break;
            }

            // Sandık ekleme
            case 'CHEST_ADD': {
                const cid = nextChestId++;
                const chest = { id: cid, gx: msg.gx, gy: msg.gy, x: msg.x, y: msg.y, world: msg.world, items: msg.items };
                chests.set(cid, chest);
                broadcastAll({ type: 'CHEST_ADD', chest });
                break;
            }

            // Sandık içeriği güncelle (item taşıma)
            case 'CHEST_UPDATE': {
                const chest = chests.get(msg.id);
                if (chest) {
                    chest.items = msg.items;
                    broadcast({ type: 'CHEST_UPDATE', id: msg.id, items: msg.items }, id);
                }
                break;
            }

            // Mermi / ok
            case 'PROJECTILE': {
                broadcast({ type: 'PROJECTILE', ...msg, fromId: id }, id);
                break;
            }

            // Bomba
            case 'GRENADE': {
                broadcast({ type: 'GRENADE', ...msg, fromId: id }, id);
                break;
            }

            // Bomba patlaması
            case 'EXPLOSION': {
                broadcast({ type: 'EXPLOSION', ...msg, fromId: id }, id);
                break;
            }

            // Hasar al (PvP)
            case 'DAMAGE': {
                const target = players.get(msg.targetId);
                if (!target) break;
                target.state.health = Math.max(0, target.state.health - msg.amount);
                if (target.state.health <= 0) target.state.isDead = true;
                send(target.ws, { type: 'HIT', amount: msg.amount, fromId: id });
                broadcast({ type: 'PLAYER_UPDATE', ...target.state });
                break;
            }

            // Dünya eşyası bırak
            case 'WORLD_ITEM_DROP': {
                const wid = nextItemId++;
                const item = { ...msg.item, id: wid, world: msg.world };
                worldItems.set(wid, item);
                broadcastAll({ type: 'WORLD_ITEM_ADD', item });
                break;
            }

            // Dünya eşyasını topla
            case 'WORLD_ITEM_PICKUP': {
                if (worldItems.delete(msg.id)) {
                    broadcastAll({ type: 'WORLD_ITEM_REMOVE', id: msg.id });
                }
                break;
            }

            // Meşale ekle
            case 'TORCH_ADD': {
                broadcast({ type: 'TORCH_ADD', ...msg }, id);
                break;
            }

            // Chat mesajı
            case 'CHAT': {
                broadcastAll({ type: 'CHAT', fromId: id, name: state.name, text: msg.text.slice(0, 120) });
                break;
            }

            // İsim güncelle
            case 'SET_NAME': {
                state.name = String(msg.name).slice(0, 20);
                broadcast({ type: 'PLAYER_NAME', id, name: state.name });
                break;
            }
        }
    });

    ws.on('close', () => {
        players.delete(id);
        broadcast({ type: 'PLAYER_LEAVE', id });
        console.log(`[-] Oyuncu ${id} ayrıldı. Toplam: ${players.size}`);
    });

    ws.on('error', (e) => console.error(`Oyuncu ${id} hata:`, e.message));
});

// ─── Server tick: pozisyonları toplu broadcast (opsiyonel, şu an client-driven) 
// İleride lag compensation buraya eklenebilir

httpServer.listen(PORT, () => {
    console.log(`✅ AeroGrid Sunucu çalışıyor → http://localhost:${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}`);
});
