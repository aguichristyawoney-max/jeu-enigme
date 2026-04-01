const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, { maxHttpBufferSize: 5e6 });

app.use(express.static('public'));

const parties = {};

// Nettoyage automatique des parties inactives depuis plus de 2h
setInterval(() => {
  const maintenant = Date.now();
  Object.keys(parties).forEach(code => {
    const partie = parties[code];
    if (maintenant - partie.derniereActivite > 2 * 60 * 60 * 1000) {
      if (partie.timerInterval) clearInterval(partie.timerInterval);
      io.to(code).emit('partie_annulee');
      delete parties[code];
      console.log(`Partie ${code} nettoyée (inactivité)`);
    }
  });
}, 15 * 60 * 1000);

function genererCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

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

function toucherPartie(code) {
  if (parties[code]) parties[code].derniereActivite = Date.now();
}

io.on('connection', (socket) => {
  console.log('Connecté:', socket.id);

  socket.on('admin_creer_partie', ({ nomAdmin } = {}) => {
    let code = genererCode();
    while (parties[code]) code = genererCode();

    const nomAffiche = nomAdmin ? `${nomAdmin} 👑` : '👑 Admin';

    parties[code] = {
      code,
      adminId: socket.id,
      nomAdmin: nomAffiche,
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
      messages: [],
      questionActuelle: null,
      imageActuelle: null,
      derniereActivite: Date.now(),
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.isAdmin = true;
    socket.emit('partie_creee', { code, nomAdmin: nomAffiche });
  });

  socket.on('admin_rejoindre', ({ code }) => {
    const partie = parties[code];
    if (!partie) { socket.emit('erreur', 'Partie introuvable'); return; }
    partie.adminId = socket.id;
    socket.join(code);
    socket.data.code = code;
    socket.data.isAdmin = true;
    socket.emit('partie_creee', { code, nomAdmin: partie.nomAdmin });
    socket.emit('joueurs_update', Object.values(partie.joueurs));
    const scores = Object.entries(partie.scores).map(([nom, points]) => ({ nom, points }));
    socket.emit('points_update', scores);
    partie.messages.forEach(m => socket.emit('chat_message', m));
    if (partie.phase === 'playing' && partie.tempsDepart) {
      const ecoule = Math.floor((Date.now() - partie.tempsDepart) / 1000);
      const restant = Math.max(0, partie.tempsDuration - ecoule);
      socket.emit('admin_question_encours', {
        question: partie.questionActuelle,
        image: partie.imageActuelle,
        temps: restant,
        pointsMax: partie.pointsMax
      });
    }
    toucherPartie(code);
  });

  socket.on('joueur_rejoindre', ({ code, nom }) => {
    const partie = parties[code];
    if (!partie) { socket.emit('erreur', 'Code de partie invalide !'); return; }

    const ancienId = Object.keys(partie.joueurs).find(id => partie.joueurs[id].nom === nom);
    if (ancienId) delete partie.joueurs[ancienId];

    partie.joueurs[socket.id] = { id: socket.id, nom };
    partie.scores[nom] = partie.scores[nom] || 0;
    socket.join(code);
    socket.data.code = code;
    socket.data.nom = nom;

    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    socket.emit('partie_rejointe', { code, nom });

    const scores = Object.entries(partie.scores).map(([n, pts]) => ({ nom: n, points: pts }));
    socket.emit('points_update', scores);

    partie.messages.forEach(m => socket.emit('chat_message', m));

    if (partie.phase === 'playing' && partie.tempsDepart) {
      const ecoule = Math.floor((Date.now() - partie.tempsDepart) / 1000);
      const restant = Math.max(0, partie.tempsDuration - ecoule);
      socket.emit('nouvelle_question', {
        question: partie.questionActuelle,
        image: partie.imageActuelle,
        temps: restant,
        tempsTotal: partie.tempsDuration,
        pointsMax: partie.pointsMax
      });
    }

    if (partie.phase === 'recap') {
      socket.emit('fin_question', { reponses: _buildReponses(partie) });
    }

    toucherPartie(code);
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
    partie.questionActuelle = question;
    partie.imageActuelle = image || null;
    partie.pointDonneCetteQuestion = false;

    if (partie.timerInterval) clearInterval(partie.timerInterval);

    io.to(code).emit('nouvelle_question', {
      question,
      image,
      temps,
      tempsTotal: temps,
      pointsMax
    });
    io.to(partie.adminId).emit('admin_chrono_start', { temps });

    partie.timerInterval = setInterval(() => {
      if (!parties[code]) { clearInterval(partie.timerInterval); return; }
      const ecoule = Math.floor((Date.now() - partie.tempsDepart) / 1000);
      if (ecoule >= temps) {
        clearInterval(partie.timerInterval);
        partie.phase = 'recap';
        const reponses = _buildReponses(partie);
        io.to(code).emit('fin_question', { reponses });
      }
    }, 1000);

    toucherPartie(code);
  });

  socket.on('admin_couper_temps', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    if (partie.timerInterval) clearInterval(partie.timerInterval);
    partie.phase = 'recap';
    const reponses = _buildReponses(partie);
    io.to(code).emit('fin_question', { reponses });
    toucherPartie(code);
  });

  socket.on('joueur_reponse', ({ code, nom, reponse, tempsReponse }) => {
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;
    if (!partie.reponses[nom]) partie.reponses[nom] = { nom, historique: [] };
    partie.reponses[nom].historique.push({ reponse, tempsReponse });
    io.to(partie.adminId).emit('reponse_joueur', _buildReponses(partie));
    socket.emit('reponse_joueur', _buildReponses(partie));
    // Notifier l'admin qu'une nouvelle réponse est arrivée (pour badge onglet)
    io.to(partie.adminId).emit('nouvelle_reponse_badge');
    toucherPartie(code);
  });

  socket.on('admin_donner_points', ({ code, nom, points }) => {
    const partie = parties[code];
    if (!partie || partie.pointDonneCetteQuestion) return;
    partie.scores[nom] = (partie.scores[nom] || 0) + points;
    partie.pointDonneCetteQuestion = true;

    if (partie.timerInterval) clearInterval(partie.timerInterval);
    partie.phase = 'recap';

    const scores = Object.entries(partie.scores).map(([n, p]) => ({ nom: n, points: p }));
    io.to(code).emit('points_update', scores);
    io.to(partie.adminId).emit('point_deja_donne');

    io.to(code).emit('joueur_a_trouve', { nom });

    const reponses = _buildReponses(partie);
    io.to(code).emit('fin_question', { reponses });
    toucherPartie(code);
  });

  socket.on('admin_personne_a_trouve', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    partie.pointDonneCetteQuestion = true;

    if (partie.timerInterval) clearInterval(partie.timerInterval);
    partie.phase = 'recap';

    io.to(code).emit('personne_a_trouve');
    io.to(partie.adminId).emit('point_deja_donne');

    const reponses = _buildReponses(partie);
    io.to(code).emit('fin_question', { reponses });
    toucherPartie(code);
  });

  socket.on('admin_modifier_score', ({ code, nom, nouveauScore }) => {
    const partie = parties[code];
    if (!partie) return;
    partie.scores[nom] = parseInt(nouveauScore) || 0;
    const scores = Object.entries(partie.scores).map(([n, p]) => ({ nom: n, points: p }));
    io.to(code).emit('points_update', scores);
    toucherPartie(code);
  });

  socket.on('joueur_reaction', ({ code, nomCible, emoji }) => {
    const partie = parties[code];
    if (!partie) return;
    if (!partie.reactions[nomCible]) partie.reactions[nomCible] = {};
    if (!partie.reactions[nomCible][emoji]) partie.reactions[nomCible][emoji] = 0;
    partie.reactions[nomCible][emoji]++;
    io.to(code).emit('reaction_update', { nomCible, reactions: partie.reactions[nomCible] });
    toucherPartie(code);
  });

  socket.on('joueur_demande_indice', ({ code }) => {
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;
    partie.demandesIndice.add(socket.id);
    const nbJoueurs = Object.keys(partie.joueurs).length;
    const nbDemandes = partie.demandesIndice.size;
    const majorite = nbDemandes > nbJoueurs / 2;
    io.to(partie.adminId).emit('demande_indice_update', { nbDemandes, nbJoueurs, majorite });
    toucherPartie(code);
  });

  socket.on('admin_envoyer_indice', ({ code, indice }) => {
    const partie = parties[code];
    if (!partie) return;
    io.to(code).emit('indice_recu', { indice });
    toucherPartie(code);
  });

  socket.on('chat_message', ({ code, nom, message, replyTo }) => {
    const partie = parties[code];
    if (!partie) return;
    const msg = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      nom,
      message,
      replyTo: replyTo || null,
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };
    partie.messages.push(msg);
    // Garder max 200 messages en mémoire
    if (partie.messages.length > 200) partie.messages.shift();
    io.to(code).emit('chat_message', msg);
    // Notifier l'admin d'un nouveau message chat (pour badge onglet)
    io.to(partie.adminId).emit('nouveau_chat_badge');
    toucherPartie(code);
  });

  socket.on('admin_fin_partie', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    if (partie.timerInterval) clearInterval(partie.timerInterval);
    const scores = Object.entries(partie.scores).map(([nom, points]) => ({ nom, points }));
    io.to(code).emit('scores_finaux', scores);
    delete parties[code];
  });

  socket.on('admin_annuler_partie', ({ code }) => {
    const partie = parties[code];
    if (!partie) return;
    if (partie.timerInterval) clearInterval(partie.timerInterval);
    io.to(code).emit('partie_annulee');
    delete parties[code];
  });

  socket.on('joueur_quitte_page', ({ code, nom }) => {
    const partie = parties[code];
    if (!partie) return;
    io.to(partie.adminId).emit('alerte_triche', { nom, message: `⚠️ ${nom} a quitté la page !` });
  });

  socket.on('joueur_revient_page', ({ code, nom }) => {
    const partie = parties[code];
    if (!partie) return;
    io.to(partie.adminId).emit('alerte_triche', { nom, message: `👀 ${nom} est revenu sur la page` });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !parties[code]) return;
    const partie = parties[code];
    setTimeout(() => {
      if (partie.joueurs && partie.joueurs[socket.id]) {
        delete partie.joueurs[socket.id];
        partie.demandesIndice.delete(socket.id);
        io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
      }
    }, 300000);
  });
});

server.listen(3000, () => {
  console.log('Serveur lancé sur http://localhost:3000');
});