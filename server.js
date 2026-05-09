const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' folder or root
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Queues for matching
let videoQueue = [];
let textQueue = [];
let activeUsers = new Map(); // socket.id -> socket

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  activeUsers.set(socket.id, socket);
  
  // User joins queue
  socket.on('join', ({ mode }) => {
    socket.mode = mode || 'video';
    socket.partner = null;
    
    const queue = socket.mode === 'video' ? videoQueue : textQueue;
    
    // Try to find a partner
    if (queue.length > 0) {
      const partner = queue.shift();
      
      // Make sure partner is still connected
      if (activeUsers.has(partner.id)) {
        pairUsers(socket, partner);
      } else {
        queue.push(socket);
        socket.emit('status', 'Waiting for a stranger...');
      }
    } else {
      queue.push(socket);
      socket.emit('status', 'Waiting for a stranger...');
    }
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    if (socket.partner) {
      socket.partner.emit('offer', data);
    }
  });

  socket.on('answer', (data) => {
    if (socket.partner) {
      socket.partner.emit('answer', data);
    }
  });

  socket.on('ice-candidate', (data) => {
    if (socket.partner) {
      socket.partner.emit('ice-candidate', data);
    }
  });

  // Text messages
  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', 'Stranger: ' + msg);
    }
  });

  // Next stranger
  socket.on('next', () => {
    disconnectPartner(socket);
    // Rejoin queue in same mode
    socket.emit('join', { mode: socket.mode });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    disconnectPartner(socket);
    removeFromQueues(socket);
    activeUsers.delete(socket.id);
  });
});

function pairUsers(user1, user2) {
  user1.partner = user2;
  user2.partner = user1;
  
  user1.emit('status', 'Connected! Say hi.');
  user2.emit('status', 'Connected! Say hi.');
  
  // Video mode: user1 creates offer
  if (user1.mode === 'video') {
    user1.emit('create-offer');
  }
}

function disconnectPartner(socket) {
  if (socket.partner) {
    socket.partner.emit('status', 'Stranger disconnected.');
    socket.partner.emit('partner-disconnected');
    socket.partner.partner = null;
    socket.partner = null;
  }
}

function removeFromQueues(socket) {
  videoQueue = videoQueue.filter(s => s.id !== socket.id);
  textQueue = textQueue.filter(s => s.id !== socket.id);
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
