const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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

  socket.on('admin_creer_partie', () => {
    let code = genererCode();
    while (parties[code]) code = genererCode();

    parties[code] = {
      code,
      adminId: socket.id,
      joueurs: {},
      scores: {},
      reponses: {},
      reactions: {},
      demandesIndice: new Set(),
      phase: 'attente',
      tempsDepart: null,
      tempsDuration: null,
      pointsMax: 1,
      timerInterval: null,
      messages: []
    };

    socket.join(code);
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

    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    socket.emit('partie_rejointe', { code, nom });
  });

  socket.on('admin_question', ({ code, question, image, temps, pointsMax }) => {
    const partie = parties[code];
    if (!partie) return;

    partie.reponses = {};
    partie.reactions = {};
    partie.demandesIndice = new Set();
    partie.phase = 'playing';
    partie.tempsDepart = Date.now();
    partie.tempsDuration = temps;
    partie.pointsMax = pointsMax || 1;

    if (partie.timerInterval) clearTimeout(partie.timerInterval);

    io.to(code).emit('nouvelle_question', { question, image, temps, pointsMax: partie.pointsMax });

    partie.timerInterval = setTimeout(() => {
      if (partie.phase !== 'playing') return;
      partie.phase = 'resultat';
      io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
    }, temps * 1000);
  });

  socket.on('joueur_repond', ({ code, nom, reponse }) => {
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;

    const tempsEcoule = Math.floor((Date.now() - partie.tempsDepart) / 1000);

    if (!partie.reponses[socket.id]) {
      partie.reponses[socket.id] = { nom, historique: [] };
    }
    partie.reponses[socket.id].historique.push({ reponse, tempsReponse: tempsEcoule });

    io.to(partie.adminId).emit('reponse_joueur', Object.values(partie.reponses));
  });

  socket.on('admin_couper_temps', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    if (partie.timerInterval) clearTimeout(partie.timerInterval);
    partie.phase = 'resultat';
    io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
  });

  socket.on('admin_donner_points', ({ code, nom, points }) => {
    const partie = parties[code];
    if (!partie) return;

    partie.scores[nom] = (partie.scores[nom] || 0) + points;
    const scoresArray = Object.entries(partie.scores).map(([n, p]) => ({ nom: n, points: p }));
    io.to(code).emit('points_update', scoresArray);

    if (partie.timerInterval) clearTimeout(partie.timerInterval);
    partie.phase = 'resultat';
    io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
    socket.emit('point_deja_donne');
  });

  socket.on('admin_personne_a_trouve', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    if (partie.timerInterval) clearTimeout(partie.timerInterval);
    partie.phase = 'resultat';
    io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
    io.to(code).emit('personne_a_trouve');
    socket.emit('point_deja_donne');
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
    if (!partie) return;
    io.to(code).emit('indice_recu', { indice });
  });

  socket.on('chat_message', ({ code, nom, message }) => {
    const partie = parties[code];
    if (!partie) return;
    const msg = {
      nom, message,
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };
    partie.messages.push(msg);
    io.to(code).emit('chat_message', msg);
  });

  socket.on('admin_fin_partie', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    const scores = Object.entries(partie.scores).map(([nom, points]) => ({ nom, points }));
    io.to(code).emit('scores_finaux', scores);
    delete parties[code];
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !parties[code]) return;
    const partie = parties[code];
    delete partie.joueurs[socket.id];
    partie.demandesIndice.delete(socket.id);
    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
  });
});

function _buildReponses(partie) {
  return Object.values(partie.reponses).map(r => ({
    nom: r.nom,
    reponse: r.historique && r.historique.length > 0
      ? r.historique[r.historique.length - 1].reponse
      : '(pas de réponse)',
    tempsReponse: r.historique && r.historique.length > 0
      ? r.historique[0].tempsReponse
      : 0,
    historique: r.historique || []
  }));
}

server.listen(3000, () => {
  console.log('Serveur lancé sur http://localhost:3000');
});