const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Stockage des parties
const parties = {};

io.on('connection', (socket) => {
    console.log('Connexion détectée:', socket.id);

    // --- LOGIQUE ADMIN ---

    socket.on('admin_creer_partie', ({ codeExistant }) => {
        let code = codeExistant || Math.random().toString(36).substring(2, 8).toUpperCase();
        
        if (!parties[code]) {
            parties[code] = {
                adminId: socket.id,
                joueurs: [],
                enCours: false,
                questionActuelle: null
            };
        } else {
            parties[code].adminId = socket.id;
        }

        socket.join(code);
        socket.emit('partie_creee', { code });
        io.to(code).emit('joueurs_update', parties[code].joueurs);
    });

    socket.on('admin_lancer_jeu', ({ code }) => {
        if (parties[code]) {
            parties[code].enCours = true;
            io.to(code).emit('jeu_demarre');
        }
    });

    socket.on('admin_question', ({ code, question, image, temps, pointsMax }) => {
        if (parties[code]) {
            parties[code].questionActuelle = { question, pointsMax };
            // On réinitialise l'historique des réponses pour la nouvelle question
            parties[code].joueurs.forEach(j => j.historique = []);
            
            io.to(code).emit('nouvelle_question', { question, image, temps, pointsMax });
            io.to(code).emit('reponse_joueur', parties[code].joueurs);
        }
    });

    socket.on('admin_couper_temps', ({ code }) => {
        io.to(code).emit('stop_timer');
    });

    // LA FONCTION QUE TU AS DEMANDÉ
    socket.on('admin_personne_a_trouve', ({ code }) => {
        if (parties[code]) {
            // 1. On avertit les joueurs que personne ne gagne
            io.to(code).emit('personne_a_trouve_notif', {
                message: "🤷‍♂️ Personne n'a trouvé ! 0 point pour ce tour."
            });

            // 2. On arrête le chrono chez tout le monde
            io.to(code).emit('stop_timer');

            // 3. Message auto dans le chat
            const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            io.to(code).emit('chat_message', {
                nom: "📢 SYSTÈME",
                message: "Fin de l'énigme : personne n'a trouvé.",
                heure: heure
            });
        }
    });

    socket.on('admin_donner_points', ({ code, nom, points }) => {
        if (parties[code]) {
            const joueur = parties[code].joueurs.find(j => j.nom === nom);
            if (joueur) {
                const ptsGagnes = parseInt(points) || 0;
                joueur.points += ptsGagnes;
                
                // On notifie l'admin que c'est bien enregistré pour verrouiller son interface
                socket.emit('point_deja_donne');
                
                // Update général
                io.to(code).emit('points_update', parties[code].joueurs);
                io.to(code).emit('recompense_animation', { nom, points: ptsGagnes });
            }
        }
    });

    socket.on('admin_envoyer_indice', ({ code, indice }) => {
        io.to(code).emit('recevoir_indice', { indice });
    });

    socket.on('admin_fin_partie', ({ code }) => {
        if (parties[code]) {
            io.to(code).emit('scores_finaux', parties[code].joueurs);
            delete parties[code];
        }
    });

    // --- LOGIQUE JOUEUR ---

    socket.on('joueur_rejoindre', ({ code, nom }) => {
        if (parties[code]) {
            socket.join(code);
            const nouveauJoueur = {
                id: socket.id,
                nom: nom,
                points: 0,
                historique: [],
                reactions: {}
            };
            parties[code].joueurs.push(nouveauJoueur);
            io.to(code).emit('joueurs_update', parties[code].joueurs);
        } else {
            socket.emit('erreur', 'Partie introuvable');
        }
    });

    socket.on('joueur_reponse', ({ code, nom, reponse, tempsReponse }) => {
        if (parties[code]) {
            const joueur = parties[code].joueurs.find(j => j.nom === nom);
            if (joueur) {
                joueur.historique.push({ reponse, tempsReponse });
                io.to(code).emit('reponse_joueur', parties[code].joueurs);
            }
        }
    });

    socket.on('joueur_reaction', ({ code, nomCible, emoji }) => {
        if (parties[code]) {
            const joueur = parties[code].joueurs.find(j => j.nom === nomCible);
            if (joueur) {
                joueur.reactions[emoji] = (joueur.reactions[emoji] || 0) + 1;
                io.to(code).emit('reaction_update', { nomCible, reactions: joueur.reactions });
            }
        }
    });

    socket.on('chat_message', ({ code, nom, message }) => {
        const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        io.to(code).emit('chat_message', { nom, message, heure });
    });

    socket.on('disconnect', () => {
        console.log('Déconnexion:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
