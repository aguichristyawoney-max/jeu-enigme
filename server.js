const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, { maxHttpBufferSize: 5e6 });

app.use(express.static('public'));

const parties = {};

// ══════════════════════════════════════
//  UTILITAIRES
// ══════════════════════════════════════

function genererCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function toucherPartie(code) {
  if (parties[code]) parties[code].derniereActivite = Date.now();
}

// Validation basique des strings reçues via socket
function validerString(val, maxLen = 200) {
  return typeof val === 'string' && val.length > 0 && val.length <= maxLen;
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

// ══════════════════════════════════════
//  TIMER GLOBAL (un seul setInterval pour toutes les parties)
//  Remplace le setInterval par partie — évite N timers en parallèle
// ══════════════════════════════════════

const TICK_MS = 1000;

setInterval(() => {
  const maintenant = Date.now();
  Object.keys(parties).forEach(code => {
    const partie = parties[code];

    // Nettoyage des parties inactives depuis plus de 2h
    if (maintenant - partie.derniereActivite > 2 * 60 * 60 * 1000) {
      io.to(code).emit('partie_annulee');
      delete parties[code];
      console.log(`Partie ${code} nettoyée (inactivité)`);
      return;
    }

    // Décompte du timer de question
    if (partie.phase === 'playing' && partie.tempsDepart) {
      const ecoule = Math.floor((maintenant - partie.tempsDepart) / 1000);
      if (ecoule >= partie.tempsDuration) {
        partie.phase = 'recap';
        partie.tempsDepart = null;
        const reponses = _buildReponses(partie);
        io.to(code).emit('fin_question', { reponses });
      }
    }
  });
}, TICK_MS);

// ══════════════════════════════════════
//  CONNEXIONS SOCKET
// ══════════════════════════════════════

io.on('connection', (socket) => {
  console.log('Connecté:', socket.id);

  // ── Créer une partie ──
  socket.on('admin_creer_partie', ({ nomAdmin } = {}) => {
    const nomPropre = validerString(nomAdmin, 30) ? nomAdmin.trim() : 'Admin';
    const nomAffiche = `${nomPropre} 👑`;

    let code = genererCode();
    while (parties[code]) code = genererCode();

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
      messages: [],
      questionActuelle: null,
      imageActuelle: null,
      pointDonneCetteQuestion: false,
      derniereActivite: Date.now(),
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.isAdmin = true;
    socket.emit('partie_creee', { code, nomAdmin: nomAffiche });
  });

  // ── Admin se reconnecte ──
  socket.on('admin_rejoindre', ({ code } = {}) => {
    if (!validerString(code, 6)) { socket.emit('erreur', 'Code invalide'); return; }
    const partie = parties[code];
    if (!partie) { socket.emit('erreur', 'Partie introuvable ou expirée'); return; }

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

    // Restaurer les réponses en cours si la question est active
    if (partie.phase === 'playing') {
      socket.emit('reponse_joueur', _buildReponses(partie));
    }

    toucherPartie(code);
  });

  // ── Joueur rejoint ──
  socket.on('joueur_rejoindre', ({ code, nom } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) {
      socket.emit('erreur', 'Données invalides');
      return;
    }

    const partie = parties[code];
    if (!partie) {
      socket.emit('erreur', 'Code de partie invalide ou partie expirée !');
      return;
    }

    const nomTrim = nom.trim();

    // FIX : Refuser les noms en doublon pour éviter les collisions de scores
    const ancienSocket = Object.values(partie.joueurs).find(j => j.nom === nomTrim);
    if (ancienSocket) {
      // C'est une reconnexion du même joueur — on met à jour son socket
      delete partie.joueurs[ancienSocket.id];
    }

    partie.joueurs[socket.id] = { id: socket.id, nom: nomTrim };
    partie.scores[nomTrim] = partie.scores[nomTrim] || 0;

    socket.join(code);
    socket.data.code = code;
    socket.data.nom = nomTrim;

    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    socket.emit('partie_rejointe', { code, nom: nomTrim });

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

  // ── Envoi d'une question ──
  socket.on('admin_question', ({ code, question, image, temps, pointsMax } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    // Validation du temps et des points
    const tempsSec = Math.min(Math.max(parseInt(temps) || 30, 5), 300);
    const pointsMaxVal = Math.min(Math.max(parseInt(pointsMax) || 1, 1), 20);

    partie.reponses = {};
    partie.reactions = {};
    partie.demandesIndice = new Set();
    partie.phase = 'playing';
    partie.tempsDepart = Date.now();
    partie.tempsDuration = tempsSec;
    partie.pointsMax = pointsMaxVal;
    partie.questionActuelle = validerString(question, 500) ? question : '';
    partie.imageActuelle = (typeof image === 'string' && image.startsWith('data:image')) ? image : null;
    partie.pointDonneCetteQuestion = false;

    io.to(code).emit('nouvelle_question', {
      question: partie.questionActuelle,
      image: partie.imageActuelle,
      temps: tempsSec,
      tempsTotal: tempsSec,
      pointsMax: pointsMaxVal
    });
    io.to(partie.adminId).emit('admin_chrono_start', { temps: tempsSec });

    toucherPartie(code);
  });

  // ── Couper le temps ──
  socket.on('admin_couper_temps', ({ code } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    partie.phase = 'recap';
    partie.tempsDepart = null;
    const reponses = _buildReponses(partie);
    io.to(code).emit('fin_question', { reponses });
    toucherPartie(code);
  });

  // ── Réponse d'un joueur ──
  socket.on('joueur_reponse', ({ code, nom, reponse, tempsReponse } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30) || !validerString(reponse, 300)) return;
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;

    // Vérifier que le joueur appartient bien à la partie
    const joueurValide = Object.values(partie.joueurs).some(j => j.nom === nom);
    if (!joueurValide) return;

    const tempsVal = Math.max(0, parseInt(tempsReponse) || 0);

    if (!partie.reponses[nom]) partie.reponses[nom] = { nom, historique: [] };
    partie.reponses[nom].historique.push({ reponse: reponse.trim(), tempsReponse: tempsVal });

    const reponses = _buildReponses(partie);
    io.to(partie.adminId).emit('reponse_joueur', reponses);
    socket.emit('reponse_joueur', reponses);
    io.to(partie.adminId).emit('nouvelle_reponse_badge');
    toucherPartie(code);
  });

  // ── Admin donne des points ──
  socket.on('admin_donner_points', ({ code, nom, points } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id || partie.pointDonneCetteQuestion) return;

    const ptsVal = Math.min(Math.max(parseInt(points) || 0, 0), 20);
    partie.scores[nom] = (partie.scores[nom] || 0) + ptsVal;
    partie.pointDonneCetteQuestion = true;
    partie.phase = 'recap';
    partie.tempsDepart = null;

    const scores = Object.entries(partie.scores).map(([n, p]) => ({ nom: n, points: p }));
    io.to(code).emit('points_update', scores);
    io.to(partie.adminId).emit('point_deja_donne');
    io.to(code).emit('joueur_a_trouve', { nom });
    io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
    toucherPartie(code);
  });

  // ── Personne n'a trouvé ──
  socket.on('admin_personne_a_trouve', ({ code } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    partie.pointDonneCetteQuestion = true;
    partie.phase = 'recap';
    partie.tempsDepart = null;

    io.to(code).emit('personne_a_trouve');
    io.to(partie.adminId).emit('point_deja_donne');
    io.to(code).emit('fin_question', { reponses: _buildReponses(partie) });
    toucherPartie(code);
  });

  // ── Modifier un score manuellement ──
  socket.on('admin_modifier_score', ({ code, nom, nouveauScore } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    partie.scores[nom] = Math.max(0, parseInt(nouveauScore) || 0);
    const scores = Object.entries(partie.scores).map(([n, p]) => ({ nom: n, points: p }));
    io.to(code).emit('points_update', scores);
    toucherPartie(code);
  });

  // ── Réaction emoji ──
  socket.on('joueur_reaction', ({ code, nomCible, emoji } = {}) => {
    if (!validerString(code, 6) || !validerString(nomCible, 30) || !validerString(emoji, 10)) return;
    const partie = parties[code];
    if (!partie) return;

    if (!partie.reactions[nomCible]) partie.reactions[nomCible] = {};
    if (!partie.reactions[nomCible][emoji]) partie.reactions[nomCible][emoji] = 0;
    partie.reactions[nomCible][emoji]++;
    io.to(code).emit('reaction_update', { nomCible, reactions: partie.reactions[nomCible] });
    toucherPartie(code);
  });

  // ── Demande d'indice ──
  socket.on('joueur_demande_indice', ({ code } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.phase !== 'playing') return;

    partie.demandesIndice.add(socket.id);
    const nbJoueurs = Object.keys(partie.joueurs).length;
    const nbDemandes = partie.demandesIndice.size;
    const majorite = nbDemandes > nbJoueurs / 2;
    io.to(partie.adminId).emit('demande_indice_update', { nbDemandes, nbJoueurs, majorite });
    toucherPartie(code);
  });

  // ── Envoi d'un indice ──
  socket.on('admin_envoyer_indice', ({ code, indice } = {}) => {
    if (!validerString(code, 6) || !validerString(indice, 300)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    io.to(code).emit('indice_recu', { indice: indice.trim() });
    toucherPartie(code);
  });

  // ── Message chat ──
  socket.on('chat_message', ({ code, nom, message, replyTo } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 50) || !validerString(message, 500)) return;
    const partie = parties[code];
    if (!partie) return;

    // Valider le replyTo si présent
    const replyToValide = replyTo && validerString(replyTo.nom, 50) && validerString(replyTo.message, 500)
      ? { id: replyTo.id, nom: replyTo.nom, message: replyTo.message }
      : null;

    const msg = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      nom: nom.trim(),
      message: message.trim(),
      replyTo: replyToValide,
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };

    partie.messages.push(msg);
    if (partie.messages.length > 200) partie.messages.shift();

    io.to(code).emit('chat_message', msg);
    // FIX : émettre l'événement que admin.html écoute pour le badge
    io.to(partie.adminId).emit('nouveau_chat_badge');
    toucherPartie(code);
  });

  // ── Fin de partie ──
  socket.on('admin_fin_partie', ({ code } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    const scores = Object.entries(partie.scores).map(([nom, points]) => ({ nom, points }));
    io.to(code).emit('scores_finaux', scores);
    delete parties[code];
  });

  // ── Annuler la partie ──
  socket.on('admin_annuler_partie', ({ code } = {}) => {
    if (!validerString(code, 6)) return;
    const partie = parties[code];
    if (!partie || partie.adminId !== socket.id) return;

    io.to(code).emit('partie_annulee');
    delete parties[code];
  });

  // ── Joueur quitte volontairement ──
  socket.on('joueur_quitter_partie', ({ code, nom } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) return;
    const partie = parties[code];
    if (!partie) return;

    delete partie.joueurs[socket.id];
    partie.demandesIndice.delete(socket.id);
    socket.leave(code);
    socket.data.code = null;
    socket.data.nom = null;

    io.to(code).emit('joueurs_update', Object.values(partie.joueurs));
    io.to(partie.adminId).emit('alerte_triche', { nom, message: `🚪 ${nom} a quitté la partie` });
    socket.emit('quitter_confirme');
    toucherPartie(code);
  });

  // ── Surveillance anti-triche ──
  socket.on('joueur_quitte_page', ({ code, nom } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) return;
    const partie = parties[code];
    if (!partie) return;
    io.to(partie.adminId).emit('alerte_triche', { nom, message: `⚠️ ${nom} a quitté la page !` });
  });

  socket.on('joueur_revient_page', ({ code, nom } = {}) => {
    if (!validerString(code, 6) || !validerString(nom, 30)) return;
    const partie = parties[code];
    if (!partie) return;
    io.to(partie.adminId).emit('alerte_triche', { nom, message: `👀 ${nom} est revenu sur la page` });
  });

  // ── Déconnexion ──
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !parties[code]) return;

    // FIX : capturer les valeurs nécessaires AVANT le setTimeout
    // pour éviter que la closure capture un état obsolète
    const capturedSocketId = socket.id;
    const capturedCode = code;

    setTimeout(() => {
      const partie = parties[capturedCode];
      // Vérifier que la partie existe encore ET que ce socket est toujours enregistré
      if (!partie) return;
      if (!partie.joueurs || !partie.joueurs[capturedSocketId]) return;

      delete partie.joueurs[capturedSocketId];
      partie.demandesIndice.delete(capturedSocketId);
      io.to(capturedCode).emit('joueurs_update', Object.values(partie.joueurs));
    }, 5 * 60 * 1000); // 5 minutes de grâce pour la reconnexion
  });
});

server.listen(3000, () => {
  console.log('Serveur lancé sur http://localhost:3000');
});