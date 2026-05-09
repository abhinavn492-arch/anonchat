const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let videoQueues = { any: [], IN: [], US: [], GB: [], CA: [] };
let textQueues = { any: [], IN: [], US: [], GB: [], CA: [] };
let activeUsers = new Map();
let waitingTimers = new Map();
let onlineCount = 0;

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  onlineCount++;
  io.emit('onlineCount', onlineCount);

  const country = socket.handshake.headers['cf-ipcountry'] || 'XX';

  activeUsers.set(socket.id, {
    socket,
    mode: null,
    partner: null,
    interests: [],
    country: country,
    countryFilter: 'any',
    joinedAt: Date.now()
  });

  socket.on('join', ({ mode, interests, country }) => {
    console.log(`${socket.id} joining ${mode} | Country: ${country} | Interests: ${interests}`);
    const userData = activeUsers.get(socket.id);
    userData.mode = mode || 'video';
    userData.interests = interests || [];
    userData.countryFilter = country || 'any';
    userData.partner = null;
    userData.joinedAt = Date.now();
    tryMatchUser(socket);
  });

  socket.on('next', () => {
    console.log(`${socket.id} clicked next`);
    const userData = activeUsers.get(socket.id);
    if (!userData) return;
    disconnectPartner(socket);
    removeFromAllQueues(socket);
    clearWaitingTimer(socket.id);
    userData.partner = null;
    userData.joinedAt = Date.now();
    tryMatchUser(socket);
  });

  socket.on('leave', () => {
    console.log(`${socket.id} left`);
    disconnectPartner(socket);
    removeFromAllQueues(socket);
    clearWaitingTimer(socket.id);
    const userData = activeUsers.get(socket.id);
    if (userData) {
      userData.mode = null;
      userData.partner = null;
    }
  });

  socket.on('report', () => {
    console.log(`${socket.id} reported partner`);
    const userData = activeUsers.get(socket.id);
    if (userData?.partner) {
      console.log(`Reported user: ${userData.partner.id}`);
      disconnectPartner(socket);
    }
  });

  socket.on('offer', (data) => {
    const userData = activeUsers.get(socket.id);
    if (userData?.partner) {
      userData.partner.emit('offer', data);
    }
  });

  socket.on('answer', (data) => {
    const userData = activeUsers.get(socket.id);
    if (userData?.partner) {
      userData.partner.emit('answer', data);
    }
  });

  socket.on('ice-candidate', (data) => {
    const userData = activeUsers.get(socket.id);
    if (userData?.partner) {
      userData.partner.emit('ice-candidate', data);
    }
  });

  socket.on('message', (msg) => {
    const userData = activeUsers.get(socket.id);
    if (userData?.partner && msg.trim()) {
      userData.partner.emit('message', 'Stranger: ' + msg);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    onlineCount--;
    io.emit('onlineCount', onlineCount);
    disconnectPartner(socket);
    removeFromAllQueues(socket);
    clearWaitingTimer(socket.id);
    activeUsers.delete(socket.id);
  });
});

function tryMatchUser(socket) {
  const userData = activeUsers.get(socket.id);
  const queues = userData.mode === 'video'? videoQueues : textQueues;
  cleanAllQueues(queues);
  let partner = findMatch(socket, queues, 'exact');
  if (partner) return pairUsers(socket, partner, 'Perfect match!');
  socket.emit('status', {
    text: 'Searching for stranger...',
    matchInfo: `Looking: ${userData.countryFilter!== 'any'? userData.countryFilter : 'Any country'} | ${userData.interests.length? userData.interests.join(', ') : 'Any interest'}`
  });
  const timer1 = setTimeout(() => {
    if (!userData.partner && activeUsers.has(socket.id)) {
      let partner = findMatch(socket, queues, 'interest');
      if (partner) return pairUsers(socket, partner, 'Matched by interest');
    }
  }, 10000);
  const timer2 = setTimeout(() => {
    if (!userData.partner && activeUsers.has(socket.id)) {
      let partner = findMatch(socket, queues, 'country');
      if (partner) return pairUsers(socket, partner, 'Matched by country');
    }
  }, 20000);
  const timer3 = setTimeout(() => {
    if (!userData.partner && activeUsers.has(socket.id)) {
      let partner = findMatch(socket, queues, 'any');
      if (partner) return pairUsers(socket, partner, 'Global match');
      else addToQueue(socket, queues);
    }
  }, 30000);
  waitingTimers.set(socket.id, [timer1, timer2, timer3]);
  addToQueue(socket, queues);
}

function findMatch(socket, queues, tier) {
  const userData = activeUsers.get(socket.id);
  const targetQueues = [];
  if (tier === 'exact') {
    if (userData.countryFilter!== 'any') {
      targetQueues.push(queues[userData.countryFilter] || []);
    } else {
      targetQueues.push(queues['any']);
    }
  } else if (tier === 'interest') {
    Object.values(queues).forEach(q => targetQueues.push(q));
  } else if (tier === 'country') {
    if (userData.countryFilter!== 'any') {
      targetQueues.push(queues[userData.countryFilter] || []);
    } else {
      targetQueues.push(queues['any']);
    }
  } else {
    Object.values(queues).forEach(q => targetQueues.push(q));
  }
  for (let queue of targetQueues) {
    for (let i = 0; i < queue.length; i++) {
      const partner = queue[i];
      if (partner.id === socket.id) continue;
      if (!activeUsers.has(partner.id) ||!partner.connected) continue;
      const partnerData = activeUsers.get(partner.id);
      if (tier === 'exact') {
        const hasSharedInterest = userData.interests.length === 0 ||
          partnerData.interests.some(int => userData.interests.includes(int));
        const countryMatch = userData.countryFilter === 'any' ||
          partnerData.country === userData.countryFilter;
        if (hasSharedInterest && countryMatch) {
          queue.splice(i, 1);
          return partner;
        }
      } else if (tier === 'interest') {
        const hasSharedInterest = userData.interests.length === 0 ||
          partnerData.interests.some(int => userData.interests.includes(int));
        if (hasSharedInterest) {
          queue.splice(i, 1);
          return partner;
        }
      } else if (tier === 'country') {
        const countryMatch = userData.countryFilter === 'any' ||
          partnerData.country === userData.countryFilter;
        if (countryMatch) {
          queue.splice(i, 1);
          return partner;
        }
      } else {
        queue.splice(i, 1);
        return partner;
      }
    }
  }
  return null;
}

function addToQueue(socket, queues) {
  const userData = activeUsers.get(socket.id);
  const queueKey = userData.countryFilter!== 'any'? userData.countryFilter : 'any';
  if (!queues[queueKey]) queues[queueKey] = [];
  if (!queues[queueKey].find(s => s.id === socket.id)) {
    queues[queueKey].push(socket);
    console.log(`${socket.id} added to ${userData.mode} queue: ${queueKey}`);
  }
}

function cleanAllQueues(queues) {
  Object.keys(queues).forEach(key => {
    queues[key] = queues[key].filter(s => s.connected && activeUsers.has(s.id));
  });
}

function clearWaitingTimer(socketId) {
  if (waitingTimers.has(socketId)) {
    waitingTimers.get(socketId).forEach(t => clearTimeout(t));
    waitingTimers.delete(socketId);
  }
}

function pairUsers(user1Socket, user2Socket, matchType) {
  clearWaitingTimer(user1Socket.id);
  clearWaitingTimer(user2Socket.id);
  const user1Data = activeUsers.get(user1Socket.id);
  const user2Data = activeUsers.get(user2Socket.id);
  user1Data.partner = user2Socket;
  user2Data.partner = user1Socket;
  const matchInfo = `Matched: ${matchType}`;
  user1Socket.emit('status', { text: 'Connected! Say hi.', matchInfo });
  user2Socket.emit('status', { text: 'Connected! Say hi.', matchInfo });
  if (user1Data.mode === 'video') {
    user1Socket.emit('create-offer');
  }
  console.log(`Paired: ${user1Socket.id} <-> ${user2Socket.id} | ${matchType}`);
}

function disconnectPartner(socket) {
  const userData = activeUsers.get(socket.id);
  if (userData?.partner) {
    const partnerData = activeUsers.get(userData.partner.id);
    if (partnerData) {
      partnerData.partner = null;
      userData.partner.emit('status', { text: 'Stranger disconnected.' });
      userData.partner.emit('partner-disconnected');
    }
    userData.partner = null;
  }
}

function removeFromAllQueues(socket) {
  [videoQueues, textQueues].forEach(queues => {
    Object.keys(queues).forEach(key => {
      queues[key] = queues[key].filter(s => s.id!== socket.id);
    });
  });
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
