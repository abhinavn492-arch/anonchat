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

// Serve all static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Send index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Queues for matching users
let videoQueue = [];
let textQueue = [];
let activeUsers = new Map(); // socket.id -> socket data

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  activeUsers.set(socket.id, { socket, mode: null, partner: null });

  // User joins queue with selected mode
  socket.on('join', ({ mode }) => {
    const userData = activeUsers.get(socket.id);
    userData.mode = mode || 'video';
    userData.partner = null;

    const queue = userData.mode === 'video' ? videoQueue : textQueue;
    
    // Try to find a partner in same mode queue
    if (queue.length > 0) {
      const partnerSocket = queue.shift();
      
      // Make sure partner still exists
      if (activeUsers.has(partnerSocket.id)) {
        pairUsers(socket, partnerSocket);
      } else {
        queue.push(socket);
        socket.emit('status', 'Waiting for a stranger...');
      }
    } else {
      queue.push(socket);
      socket.emit('status', 'Waiting for a stranger...');
    }
  });

  // WebRTC signaling - only used in video mode
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

  // Text messages - works in both modes
  socket.on('message', (msg) => {
    const userData = activeUsers.get(socket.id);
    if (userData?.partner && msg.trim()) {
      userData.partner.emit('message', 'Stranger: ' + msg);
    }
  });

  // Next stranger button
  socket.on('next', () => {
    disconnectPartner(socket);
    const userData = activeUsers.get(socket.id);
    if (userData?.mode) {
      // Rejoin same queue
      socket.emit('join', { mode: userData.mode });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    disconnectPartner(socket);
    removeFromQueues(socket);
    activeUsers.delete(socket.id);
  });
});

function pairUsers(user1Socket, user2Socket) {
  const user1Data = activeUsers.get(user1Socket.id);
  const user2Data = activeUsers.get(user2Socket.id);
  
  user1Data.partner = user2Socket;
  user2Data.partner = user1Socket;
  
  user1Socket.emit('status', 'Connected! Say hi.');
  user2Socket.emit('status', 'Connected! Say hi.');
  
  // If video mode, user1 creates WebRTC offer
  if (user1Data.mode === 'video') {
    user1Socket.emit('create-offer');
  }
}

function disconnectPartner(socket) {
  const userData = activeUsers.get(socket.id);
  if (userData?.partner) {
    const partnerData = activeUsers.get(userData.partner.id);
    if (partnerData) {
      partnerData.partner = null;
      userData.partner.emit('status', 'Stranger disconnected.');
      userData.partner.emit('partner-disconnected');
    }
    userData.partner = null;
  }
}

function removeFromQueues(socket) {
  videoQueue = videoQueue.filter(s => s.id !== socket.id);
  textQueue = textQueue.filter(s => s.id !== socket.id);
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
