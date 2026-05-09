require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme123';

const waitingQueue = [];
const bans = new Map();
const reports = new Map();

app.use(express.static('public'));
app.use(express.json());

const reportLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 1,
  message: 'Too many reports. Wait 30s.'
});

function getIpHash(socket) {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.handshake.address;
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

function isBanned(ipHash) {
  const ban = bans.get(ipHash);
  return ban && ban.expires > Date.now();
}

function broadcastUserCount() {
  io.emit('user-count', io.engine.clientsCount);
}

io.use((socket, next) => {
  if (isBanned(getIpHash(socket))) return next(new Error('banned'));
  next();
});

function findMatch(interests) {
  if (waitingQueue.length === 0) return null;
  if (interests.length > 0) {
    const matchIndex = waitingQueue.findIndex(u => u.interests.some(i => interests.includes(i)));
    if (matchIndex!== -1) return waitingQueue.splice(matchIndex, 1)[0];
  }
  return waitingQueue.shift();
}

io.on('connection', socket => {
  const ipHash = getIpHash(socket);
  console.log('Connected:', socket.id);
  broadcastUserCount();

  socket.on('find-stranger', ({ interests = [] }) => {
    const existingIndex = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (existingIndex!== -1) waitingQueue.splice(existingIndex, 1);

    const match = findMatch(interests);
    if (match) {
      const room = uuidv4();
      socket.join(room);
      match.socket.join(room);
      io.to(match.socket.id).emit('match-found', { room, initiator: true });
      socket.emit('match-found', { room, initiator: false });
      console.log('Matched rooms:', room);
    } else {
      waitingQueue.push({ socket, interests, joinedAt: Date.now() });
      socket.emit('waiting');
    }
  });

  socket.on('signal', ({ room, data }) => {
    socket.to(room).emit('signal', data);
  });

  socket.on('message', ({ room, msg }) => {
    if (!msg || msg.length > 500) return;
    socket.to(room).emit('message', msg);
  });

  socket.on('next', ({ room }) => {
    socket.to(room).emit('stranger-disconnected');
    socket.leave(room);
  });

  socket.on('report-user', ({ room, reason }) => {
    const reportedSockets = Array.from(io.sockets.adapter.rooms.get(room) || [])
   .map(id => io.sockets.sockets.get(id))
   .filter(s => s && s.id!== socket.id);
    if (reportedSockets.length === 0) return;

    const reportedHash = getIpHash(reportedSockets[0]);
    if (!reports.has(reportedHash)) reports.set(reportedHash, []);
    reports.get(reportedHash).push({ timestamp: Date.now(), reason });

    const recentReports = reports.get(reportedHash).filter(r => Date.now() - r.timestamp < 86400000);
    if (recentReports.length >= 3) {
      bans.set(reportedHash, { expires: Date.now() + 604800000, reason: 'Multiple reports' });
      reportedSockets[0].emit('banned', { reason: 'Multiple reports' });
      reportedSockets[0].disconnect();
      console.log('Auto-banned:', reportedHash.slice(0,8));
    }
  });

  socket.on('disconnect', () => {
    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index!== -1) waitingQueue.splice(index, 1);
    console.log('Disconnected:', socket.id);
    broadcastUserCount();
  });
});

app.post('/admin/ban', reportLimiter, (req, res) => {
  if (req.headers['x-admin-key']!== ADMIN_KEY) return res.status(403).send('Forbidden');
  const { ip, reason, days = 7 } = req.body;
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  bans.set(ipHash, { expires: Date.now() + days * 86400000, reason });
  res.send('Banned');
});

server.listen(PORT, () => console.log(`AnonChat running on http://localhost:${PORT}`));