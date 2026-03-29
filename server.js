const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingTimeout: 600000,
  pingInterval: 25000
});

app.use(express.static('public'));

const parties = {};

function genererCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log('Connecté:', socket.id);

  socket.on('admin_creer_partie', ({ codeExistant } = {}) => {
    if (codeExistant && parties[codeExistant]) {
      const partie = parties[codeExistant];
      partie.adminId = socket.id;
      socket.join(codeExistant);
      socket.emit('partie_creee', { code: codeExistant });
      return;
    }

    let code = genererCode();
    while (parties[code]) code = genererCode();

    parties[code] = {
      code,
      adminId: socket.id,
      joueurs: {},
      scores: {},
      question: null,
      image: null,
      reponses: {},
      reactions: {},
      demandesIndice: new Set(),
      phase: 'attente',
      tempsDepart: null,
      tempsDuration: null,
      pointsMax: 1,
      timerInterval: null,
      messages: [],
      pointDonneCetteQuestion: false  // 🔒 NOUVEAU
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.isAdmin = true;
    socket.emit('partie_creee', { code });
  });

  socket.on('joueur_rejoindre', ({ code, nom }) => {
    const partie = parties[code];
    if (!partie) { socket.emit('erreur', 'Code de partie invalide !'); return; }

    partie.joueurs[socket.id] = { id: socket.id, nom };
    partie.scores[nom] = partie.scores[nom] || 0;
    socket.join(code);
    socket.data.code = code;
    socket.data.nom = nom;
    socket.data.isAdmin = false;

    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    socket.emit('partie_rejointe', { code, nom });
  });

  socket.on('admin_question', ({ code, question, image, temps, pointsMax }) => {
    const partie = parties[code];
    if (!partie || socket.id !== partie.adminId) return;

    partie.question = question || null;
    partie.image = image || null;
    partie.reponses = {};
    partie.reactions = {};
    partie.demandesIndice = new Set();
    partie.phase = 'playing';
    partie.tempsDepart = Date.now();
    partie.tempsDuration = temps;
    partie.pointsMax = pointsMax || 1;
    partie.pointDonneCetteQuestion = false;  // 🔓 RESET à chaque nouvelle question

    if (partie.timerInterval) clearTimeout(partie.timerInterval);

    io.to(code).emit('nouvelle_question', {
      question: partie.question,
      image: partie.image,
      temps,
      pointsMax: partie.pointsMax
    });

    partie.timerInterval = setTimeout(() => {
      partie.phase = 'resultat';
      envoyerFinQuestion(code);
    }, temps * 1000);
  });

  socket.on('admin_couper_temps', ({ code }) => {
    const partie = parties[code];
    if (!partie || socket.id !== partie.adminId) return;

    if (partie.timerInterval) clearTimeout(partie.timerInterval);
    partie.phase = 'resultat';
    envoyerFinQuestion(code);
  });

  function envoyerFinQuestion(code) {
    const partie = parties[code];
    if (!partie) return;

    const reponsesFinales = Object.values(partie.reponses).map(r => ({
      nom: r.nom,
      historique: r.historique || [],
      derniere: r.historique && r.historique.length > 0
        ? r.historique[r.historique.length - 1].reponse
        : '(pas de réponse)',
      premierTemps: r.historique && r.historique.length > 0
        ? r.historique[0].tempsReponse
        : null
    }));

    io.to(code).emit('fin_question', { reponses: reponsesFinales });
  }

  socket.on('joueur_reponse', ({ code, reponse }) => {
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;

    const nom = socket.data.nom;
    const tempsEcoule = parseFloat(((Date.now() - partie.tempsDepart) / 1000).toFixed(1));

    if (!partie.reponses[nom]) {
      partie.reponses[nom] = { nom, historique: [] };
    }

    partie.reponses[nom].historique.push({ reponse, tempsReponse: tempsEcoule });

    const toutesReponses = Object.values(partie.reponses);
    io.to(partie.adminId).emit('reponse_joueur', toutesReponses);
  });

  socket.on('admin_donner_points', ({ code, nom, points }) => {
    const partie = parties[code];
    if (!partie || socket.id !== partie.adminId) return;

    // 🔒 PROTECTION : si déjà donné cette question, on ignore
    if (partie.pointDonneCetteQuestion) {
      socket.emit('point_deja_donne');
      return;
    }

    // 🔒 On verrouille immédiatement
    partie.pointDonneCetteQuestion = true;

    const pts = Math.max(0, parseInt(points) || 0);
    partie.scores[nom] = (partie.scores[nom] || 0) + pts;

    const scoresArray = Object.entries(partie.scores)
      .map(([n, p]) => ({ nom: n, points: p }));

    io.to(code).emit('points_update', scoresArray);

    if (partie.timerInterval) clearTimeout(partie.timerInterval);
    partie.phase = 'resultat';
    envoyerFinQuestion(code);
  });

  socket.on('joueur_reaction', ({ code, nomCible, emoji }) => {
    const partie = parties[code];
    if (!partie) return;

    if (!partie.reactions[nomCible]) partie.reactions[nomCible] = {};
    if (!partie.reactions[nomCible][emoji]) partie.reactions[nomCible][emoji] = 0;
    partie.reactions[nomCible][emoji]++;

    io.to(code).emit('reaction_update', { nomCible, reactions: partie.reactions[nomCible] });
  });

  socket.on('joueur_demande_indice', ({ code }) => {
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;

    partie.demandesIndice.add(socket.id);

    const nbJoueurs = Object.keys(partie.joueurs).length;
    const nbDemandes = partie.demandesIndice.size;
    const majorite = nbDemandes > nbJoueurs / 2;

    io.to(partie.adminId).emit('demande_indice_update', { nbDemandes, nbJoueurs, majorite });
  });

  socket.on('admin_envoyer_indice', ({ code, indice }) => {
    const partie = parties[code];
    if (!partie || socket.id !== partie.adminId) return;
    io.to(code).emit('indice_recu', { indice });
  });

  socket.on('chat_message', ({ code, nom, message }) => {
    const partie = parties[code];
    if (!partie) return;

    const msg = {
      nom,
      message,
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };
    partie.messages.push(msg);
    io.to(code).emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !parties[code]) return;

    const partie = parties[code];

    if (socket.data.isAdmin) {
      io.to(code).emit('admin_deconnecte');
    } else {
      delete partie.joueurs[socket.id];
      partie.demandesIndice.delete(socket.id);
      io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    }
  });
});

server.listen(3000, () => {
  console.log('Serveur lancé sur http://localhost:3000');
});
