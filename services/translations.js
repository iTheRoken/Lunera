'use strict';
(() => {

// Each row keeps the Spanish source and the five selectable interface languages.
const rows = [
 ['Bienvenido!','Welcome!','Bienvenue !','Willkommen!','Benvenuto!','Bem-vindo!'],
 ['Crea tu cuenta','Create your account','Créez votre compte','Erstelle dein Konto','Crea il tuo account','Crie sua conta'],
 ['Nombre de usuario','Username','Nom d’utilisateur','Benutzername','Nome utente','Nome de usuário'],
 ['Contraseña','Password','Mot de passe','Passwort','Password','Senha'],
 ['Iniciar sesión','Sign in','Se connecter','Anmelden','Accedi','Entrar'],
 ['Crear cuenta','Create account','Créer un compte','Konto erstellen','Crea account','Criar conta'],
 ['Cerrar sesión','Sign out','Se déconnecter','Abmelden','Esci','Sair'],
 ['Vuelve a lo que te gustó','Back to your favorites','Retrouvez vos favoris','Zurück zu deinen Favoriten','Ritrova i tuoi preferiti','Volte aos seus favoritos'],
 ['Descubre algo nuevo','Discover something new','Découvrez de nouveaux sons','Entdecke etwas Neues','Scopri qualcosa di nuovo','Descubra algo novo'],
 ['Búsquedas recientes','Recent searches','Recherches récentes','Letzte Suchanfragen','Ricerche recenti','Pesquisas recentes'],
 ['Tus canciones','Your songs','Vos titres','Deine Songs','I tuoi brani','Suas músicas'],
 ['Buscar en mi música','Search my music','Rechercher dans ma musique','Meine Musik durchsuchen','Cerca nella mia musica','Buscar nas minhas músicas'],
 ['Subir Mi Música','Upload my music','Importer ma musique','Meine Musik hochladen','Carica la mia musica','Enviar minha música'],
 ['Arrastra y suelta tus archivos de música aquí','Drag and drop music files here','Glissez vos fichiers musicaux ici','Musikdateien hier ablegen','Trascina qui i tuoi file musicali','Arraste e solte arquivos de música aqui'],
 ['Subiendo archivos...','Uploading files...','Importation des fichiers...','Dateien werden hochgeladen...','Caricamento file...','Enviando arquivos...'],
 ['Archivos subidos recientemente','Recently uploaded files','Fichiers récemment importés','Zuletzt hochgeladene Dateien','File caricati di recente','Arquivos enviados recentemente'],
 ['Seleccionar archivos','Choose files','Choisir des fichiers','Dateien auswählen','Scegli file','Selecionar arquivos'],
 ['Volumen','Volume','Volume','Lautstärke','Volume','Volume'],
 ['Mostrar cola','Show queue','Afficher la file','Warteschlange anzeigen','Mostra coda','Mostrar fila'],
 ['Ocultar cola','Hide queue','Masquer la file','Warteschlange ausblenden','Nascondi coda','Ocultar fila'],
 ['Guardar en una playlist','Save to a playlist','Enregistrer dans une playlist','In einer Playlist speichern','Salva in una playlist','Salvar em uma playlist'],
 ['Explorar su música','Explore their music','Découvrir sa musique','Musik entdecken','Esplora la sua musica','Explorar sua música'],
 ['Artistas patrocinados','Sponsored artists','Artistes sponsorisés','Gesponserte Künstler','Artisti sponsorizzati','Artistas patrocinados'],
 ['Selección de Lunera','Lunera selection','Sélection Lunera','Lunera-Auswahl','Selezione Lunera','Seleção Lunera'],
 ['Hecho cerca. Suena distinto.','Made nearby. Sounds different.','Créé près de vous. Un son différent.','Von hier. Klingt anders.','Creato vicino. Suona diverso.','Feito por perto. Soa diferente.'],
 ['Descubrí las voces que están creando su propio camino.','Discover the voices finding their own way.','Découvrez les voix qui tracent leur chemin.','Entdecke Stimmen, die ihren eigenen Weg gehen.','Scopri le voci che tracciano la propria strada.','Descubra as vozes que seguem seu próprio caminho.'],
 ['Escuchá los lanzamientos','Listen to the releases','Écoutez les sorties','Veröffentlichungen anhören','Ascolta le uscite','Ouça os lançamentos'],
 ['Playlist vacía','Empty playlist','Playlist vide','Leere Playlist','Playlist vuota','Playlist vazia'],
 ['Agrega canciones para empezar','Add songs to get started','Ajoutez des titres pour commencer','Füge Songs hinzu, um loszulegen','Aggiungi brani per iniziare','Adicione músicas para começar'],
 ['Crea tu primera playlist para comenzar','Create your first playlist to get started','Créez votre première playlist','Erstelle deine erste Playlist','Crea la tua prima playlist','Crie sua primeira playlist para começar'],
 ['Importar desde Spotify','Import from Spotify','Importer depuis Spotify','Aus Spotify importieren','Importa da Spotify','Importar do Spotify'],
 ['Importar playlist de YouTube','Import YouTube playlist','Importer une playlist YouTube','YouTube-Playlist importieren','Importa playlist YouTube','Importar playlist do YouTube'],
 ['Activa los avisos de acciones y estado','Enable action and status notifications','Activez les notifications d’actions et d’état','Aktions- und Statusmeldungen aktivieren','Attiva notifiche di azioni e stato','Ative avisos de ações e status'],
 ['Abre Lunera al iniciar Windows','Open Lunera when Windows starts','Ouvrir Lunera au démarrage de Windows','Lunera beim Windows-Start öffnen','Apri Lunera all’avvio di Windows','Abra o Lunera ao iniciar o Windows'],
 ['Elige entre modo oscuro, claro o personalizado','Choose dark, light or custom mode','Choisissez le mode sombre, clair ou personnalisé','Dunklen, hellen oder eigenen Modus wählen','Scegli la modalità scura, chiara o personalizzata','Escolha o modo escuro, claro ou personalizado'],
 ['Personaliza el color principal de la interfaz','Customize the interface accent color','Personnalisez la couleur principale','Akzentfarbe der Oberfläche anpassen','Personalizza il colore principale','Personalize a cor principal da interface'],
 ['Muestra un espectrograma animado que reacciona al ritmo','Show an animated visualizer that reacts to the beat','Affiche un visualiseur animé au rythme de la musique','Eine animierte Visualisierung im Takt anzeigen','Mostra un visualizzatore animato a ritmo di musica','Mostre um visualizador animado que reage ao ritmo'],
 ['Equilibra fluidez y consumo visual','Balance smoothness and visual performance','Équilibrez fluidité et performances','Flüssigkeit und Leistung ausgleichen','Bilancia fluidità e prestazioni','Equilibre fluidez e desempenho'],
 ['Reduce espaciados en vistas densas','Reduce spacing in dense views','Réduisez l’espacement des vues denses','Abstände in dichten Ansichten reduzieren','Riduci la spaziatura nelle viste dense','Reduza espaços em telas densas'],
 ['Minimiza animaciones y transiciones','Minimize animations and transitions','Réduisez les animations et transitions','Animationen und Übergänge minimieren','Riduci animazioni e transizioni','Minimize animações e transições'],
 ['Agrega tu propio GIF para la reproducción','Add your own playback GIF','Ajoutez votre propre GIF de lecture','Eigenes Wiedergabe-GIF hinzufügen','Aggiungi il tuo GIF di riproduzione','Adicione seu próprio GIF de reprodução'],
 ['Ajusta los niveles de frecuencia para personalizar el sonido','Adjust frequency levels to customize your sound','Ajustez les fréquences pour personnaliser le son','Frequenzpegel für deinen Klang anpassen','Regola le frequenze per personalizzare il suono','Ajuste as frequências para personalizar o som'],
 ['Ajusta automáticamente el volumen entre canciones','Automatically balance volume between songs','Équilibre automatiquement le volume entre les titres','Lautstärke zwischen Songs automatisch ausgleichen','Bilancia automaticamente il volume tra i brani','Equilibre automaticamente o volume entre músicas'],
 ['Selecciona la calidad de audio para streaming','Choose streaming audio quality','Choisissez la qualité audio du streaming','Audioqualität für Streaming wählen','Scegli la qualità audio dello streaming','Escolha a qualidade de áudio do streaming'],
 ['Continúa reproduciendo canciones similares al terminar una lista','Keep playing similar songs when a playlist ends','Continue avec des titres similaires à la fin d’une playlist','Nach dem Ende einer Playlist ähnliche Songs abspielen','Continua con brani simili alla fine di una playlist','Continue com músicas semelhantes ao terminar uma playlist'],
 ['Añade recomendaciones automáticamente a la cola','Automatically add recommendations to the queue','Ajoute automatiquement des recommandations à la file','Empfehlungen automatisch zur Warteschlange hinzufügen','Aggiunge automaticamente consigli alla coda','Adicione recomendações automaticamente à fila'],
 ['Mezcla automáticamente las canciones para una mejor experiencia','Automatically shuffle songs for a better experience','Mélange automatiquement les titres','Songs automatisch mischen','Mescola automaticamente i brani','Misture automaticamente as músicas'],
 ['Establece el volumen por defecto al iniciar la aplicación','Set the volume when the application starts','Définissez le volume au démarrage','Lautstärke beim Start der Anwendung festlegen','Imposta il volume all’avvio dell’applicazione','Defina o volume ao iniciar o aplicativo'],
 ['Almacena canciones en caché para reproducción offline','Cache songs for offline playback','Met en cache les titres pour une écoute hors ligne','Songs für die Offline-Wiedergabe zwischenspeichern','Memorizza i brani per l’ascolto offline','Salve músicas em cache para reprodução offline'],
 ['Revisa qué canciones quedaron guardadas para uso offline','Browse songs saved for offline playback','Consultez les titres enregistrés hors ligne','Für die Offline-Wiedergabe gespeicherte Songs ansehen','Esplora i brani salvati per l’ascolto offline','Veja as músicas salvas para ouvir offline'],
 ['Descarga tus playlists y configuraciones','Export your playlists and settings','Exportez vos playlists et paramètres','Playlists und Einstellungen exportieren','Esporta playlist e impostazioni','Exporte playlists e configurações'],
 ['Carga tus playlists y configuraciones desde un archivo','Load playlists and settings from a file','Importez vos playlists et paramètres depuis un fichier','Playlists und Einstellungen aus einer Datei laden','Carica playlist e impostazioni da un file','Carregue playlists e configurações de um arquivo'],
 ['Conserva canciones recientes para recomendaciones','Keep recent songs for recommendations','Conservez les titres récents pour les recommandations','Zuletzt gehörte Songs für Empfehlungen speichern','Conserva i brani recenti per i consigli','Guarde músicas recentes para recomendações'],
 ['Limpia las búsquedas guardadas','Clear saved searches','Effacez les recherches enregistrées','Gespeicherte Suchen löschen','Cancella le ricerche salvate','Limpe as pesquisas salvas'],
 ['Vacía la lista de reproducción reciente','Clear recently played songs','Effacez les titres récemment écoutés','Zuletzt gehörte Songs löschen','Cancella i brani ascoltati di recente','Limpe as músicas ouvidas recentemente'],
 ['Detiene audio, cola y visualizador activos','Stop audio, queue and visualizer','Arrête l’audio, la file et le visualiseur','Audio, Warteschlange und Visualisierung stoppen','Interrompe audio, coda e visualizzatore','Pare o áudio, a fila e o visualizador'],
 ['Configura atajos de teclado personalizados','Set up custom keyboard shortcuts','Configurez vos raccourcis clavier','Eigene Tastenkürzel festlegen','Configura scorciatoie da tastiera','Configure atalhos de teclado personalizados'],
 ['Oscuro','Dark','Sombre','Dunkel','Scuro','Escuro'],
 ['Claro','Light','Clair','Hell','Chiaro','Claro'],
 ['Personalizado','Custom','Personnalisé','Benutzerdefiniert','Personalizzato','Personalizado'],
 ['Media','Medium','Moyenne','Mittel','Media','Média'],
 ['Buscando...','Searching...','Recherche...','Suche läuft...','Ricerca...','Buscando...'],
 ['No hay playlists. Crea una nueva.','No playlists yet. Create one.','Aucune playlist. Créez-en une.','Noch keine Playlists. Erstelle eine.','Nessuna playlist. Creane una.','Nenhuma playlist. Crie uma.'],
 ['No hay canciones en tus favoritos.','No favorite songs yet.','Aucun titre favori.','Noch keine Lieblingssongs.','Nessun brano preferito.','Nenhuma música nos favoritos.'],
 ['No hay música local subida.','No local music uploaded.','Aucune musique locale importée.','Keine lokale Musik hochgeladen.','Nessuna musica locale caricata.','Nenhuma música local enviada.'],
 ['Inicio','Home','Accueil','Start','Home','Início'],
 ['Buscar','Search','Rechercher','Suchen','Cerca','Buscar'],
 ['Tu Biblioteca','Your Library','Votre bibliothèque','Deine Bibliothek','La tua libreria','Sua biblioteca'],
 ['Biblioteca','Library','Bibliothèque','Bibliothek','Libreria','Biblioteca'],
 ['Mi Música','My Music','Ma musique','Meine Musik','La mia musica','Minha música'],
 ['Mi música','My music','Ma musique','Meine Musik','La mia musica','Minha música'],
 ['Subir Música','Upload Music','Importer de la musique','Musik hochladen','Carica musica','Enviar música'],
 ['Configuración','Settings','Paramètres','Einstellungen','Impostazioni','Configurações'],
 ['Explorar','Explore','Explorer','Entdecken','Esplora','Explorar'],
 ['Importar playlist','Import playlist','Importer une playlist','Playlist importieren','Importa playlist','Importar playlist'],
 ['Artistas locales','Local artists','Artistes locaux','Lokale Künstler','Artisti locali','Artistas locais'],
 ['Créditos','Credits','Crédits','Mitwirkende','Crediti','Créditos'],
 ['General','General','Général','Allgemein','Generale','Geral'],
 ['Apariencia','Appearance','Apparence','Darstellung','Aspetto','Aparência'],
 ['Audio','Audio','Audio','Audio','Audio','Áudio'],
 ['Reproducción','Playback','Lecture','Wiedergabe','Riproduzione','Reprodução'],
 ['Cuenta','Account','Compte','Konto','Account','Conta'],
 ['Almacenamiento','Storage','Stockage','Speicher','Archiviazione','Armazenamento'],
 ['Privacidad','Privacy','Confidentialité','Datenschutz','Privacy','Privacidade'],
 ['Atajos','Shortcuts','Raccourcis','Tastenkürzel','Scorciatoie','Atalhos'],
 ['Desarrollador','Developer','Développeur','Entwickler','Sviluppatore','Desenvolvedor'],
 ['Experimental','Experimental','Expérimental','Experimentell','Sperimentale','Experimental'],
 ['Idioma de la Interfaz','Interface language','Langue de l’interface','Sprache der Oberfläche','Lingua dell’interfaccia','Idioma da interface'],
 ['Cambia el idioma de la aplicación','Change the application language','Changer la langue de l’application','Sprache der Anwendung ändern','Cambia la lingua dell’applicazione','Altere o idioma do aplicativo'],
 ['Notificaciones','Notifications','Notifications','Benachrichtigungen','Notifiche','Notificações'],
 ['Inicio Automático','Launch at startup','Lancement au démarrage','Beim Systemstart öffnen','Avvia all’accesso','Iniciar com o sistema'],
 ['Interfaz de Lunera','Lunera interface','Interface de Lunera','Lunera-Oberfläche','Interfaccia di Lunera','Interface do Lunera'],
 ['Tema de la Interfaz','Interface theme','Thème de l’interface','Oberflächendesign','Tema dell’interfaccia','Tema da interface'],
 ['Fondo Principal','Primary background','Fond principal','Primärer Hintergrund','Sfondo principale','Fundo principal'],
 ['Fondo Secundario','Secondary background','Fond secondaire','Sekundärer Hintergrund','Sfondo secondario','Fundo secundário'],
 ['Texto Principal','Primary text','Texte principal','Primärer Text','Testo principale','Texto principal'],
 ['Texto Secundario','Secondary text','Texte secondaire','Sekundärer Text','Testo secondario','Texto secundário'],
 ['Color de Acento','Accent color','Couleur d’accent','Akzentfarbe','Colore principale','Cor de destaque'],
 ['Elegir tono','Choose color','Choisir une couleur','Farbe wählen','Scegli colore','Escolher cor'],
 ['Espectrograma Visual','Audio visualizer','Visualiseur audio','Audiovisualisierung','Visualizzatore audio','Visualizador de áudio'],
 ['Opacidad del Espectrograma','Visualizer opacity','Opacité du visualiseur','Deckkraft der Visualisierung','Opacità del visualizzatore','Opacidade do visualizador'],
 ['Ajusta la intensidad visual del espectrograma a tu gusto','Adjust the visualizer intensity','Ajustez l’intensité du visualiseur','Intensität der Visualisierung anpassen','Regola l’intensità del visualizzatore','Ajuste a intensidade do visualizador'],
 ['Intensidad de Efectos Visuales','Visual effects intensity','Intensité des effets visuels','Intensität der visuellen Effekte','Intensità degli effetti visivi','Intensidade dos efeitos visuais'],
 ['Controla glow, blur y profundidad del panel','Adjust glow, blur and panel depth','Ajustez l’éclat, le flou et la profondeur','Leuchten, Unschärfe und Tiefe anpassen','Regola bagliore, sfocatura e profondità','Ajuste brilho, desfoque e profundidade'],
 ['Transparencia de Paneles','Panel transparency','Transparence des panneaux','Panel-Transparenz','Trasparenza dei pannelli','Transparência dos painéis'],
 ['Ajusta la opacidad del vidrio visual','Adjust the glass opacity','Ajustez l’opacité du verre','Deckkraft des Glaseffekts anpassen','Regola l’opacità del vetro','Ajuste a opacidade do vidro'],
 ['Calidad de Animaciones','Animation quality','Qualité des animations','Animationsqualität','Qualità delle animazioni','Qualidade das animações'],
 ['Modo Compacto','Compact mode','Mode compact','Kompaktmodus','Modalità compatta','Modo compacto'],
 ['Reducir Movimiento','Reduce motion','Réduire les animations','Bewegung reduzieren','Riduci movimento','Reduzir movimento'],
 ['GIF de Reproducción','Playback GIF','GIF de lecture','Wiedergabe-GIF','GIF di riproduzione','GIF de reprodução'],
 ['Ecualizador','Equalizer','Égaliseur','Equalizer','Equalizzatore','Equalizador'],
 ['Ecualizador Pro','Pro equalizer','Égaliseur Pro','Pro-Equalizer','Equalizzatore Pro','Equalizador Pro'],
 ['Normalización de Volumen','Volume normalization','Normalisation du volume','Lautstärkenormalisierung','Normalizzazione volume','Normalização de volume'],
 ['Calidad de Streaming','Streaming quality','Qualité du streaming','Streamingqualität','Qualità streaming','Qualidade do streaming'],
 ['Reproducción Automática','Autoplay','Lecture automatique','Automatische Wiedergabe','Riproduzione automatica','Reprodução automática'],
 ['Cola Automática','Automatic queue','File automatique','Automatische Warteschlange','Coda automatica','Fila automática'],
 ['Mezcla Inteligente','Smart shuffle','Lecture aléatoire intelligente','Intelligente Zufallswiedergabe','Riproduzione casuale intelligente','Ordem aleatória inteligente'],
 ['Volumen Predeterminado','Default volume','Volume par défaut','Standardlautstärke','Volume predefinito','Volume padrão'],
 ['Guardar Canciones en Caché','Cache songs','Mettre les titres en cache','Songs zwischenspeichern','Memorizza brani nella cache','Salvar músicas em cache'],
 ['Caché de Audio','Audio cache','Cache audio','Audio-Cache','Cache audio','Cache de áudio'],
 ['Canciones en Caché','Cached songs','Titres en cache','Zwischengespeicherte Songs','Brani nella cache','Músicas em cache'],
 ['Caché activada','Cache enabled','Cache activé','Cache aktiviert','Cache attiva','Cache ativado'],
 ['Caché desactivada','Cache disabled','Cache désactivé','Cache deaktiviert','Cache disattivata','Cache desativado'],
 ['Tamaño máximo','Maximum size','Taille maximale','Maximale Größe','Dimensione massima','Tamanho máximo'],
 ['Exportar Datos','Export data','Exporter les données','Daten exportieren','Esporta dati','Exportar dados'],
 ['Importar Datos','Import data','Importer les données','Daten importieren','Importa dati','Importar dados'],
 ['Estadísticas de Uso','Usage statistics','Statistiques d’utilisation','Nutzungsstatistiken','Statistiche di utilizzo','Estatísticas de uso'],
 ['Restablecer Aplicación','Reset application','Réinitialiser l’application','Anwendung zurücksetzen','Ripristina applicazione','Redefinir aplicativo'],
 ['Guardar Historial Reciente','Save listening history','Enregistrer l’historique d’écoute','Hörverlauf speichern','Salva cronologia di ascolto','Salvar histórico de reprodução'],
 ['Historial de Búsqueda','Search history','Historique de recherche','Suchverlauf','Cronologia ricerche','Histórico de pesquisa'],
 ['Canciones Recientes','Recent songs','Titres récents','Zuletzt gehörte Songs','Brani recenti','Músicas recentes'],
 ['Resetear Reproductor','Reset player','Réinitialiser le lecteur','Player zurücksetzen','Ripristina lettore','Redefinir reprodutor'],
 ['Atajos de Teclado','Keyboard shortcuts','Raccourcis clavier','Tastenkürzel','Scorciatoie da tastiera','Atalhos de teclado'],
 ['Modo Desarrollador','Developer mode','Mode développeur','Entwicklermodus','Modalità sviluppatore','Modo desenvolvedor'],
 ['Herramientas de Desarrollo','Developer tools','Outils de développement','Entwicklerwerkzeuge','Strumenti di sviluppo','Ferramentas de desenvolvimento'],
 ['Preferencia de Rendimiento','Performance preference','Préférence de performances','Leistungseinstellung','Preferenza prestazioni','Preferência de desempenho'],
 ['Información de la Aplicación','About the application','À propos de l’application','Über die Anwendung','Informazioni sull’applicazione','Sobre o aplicativo'],
 ['Favoritos','Favorites','Favoris','Favoriten','Preferiti','Favoritos'],
 ['Canciones','Songs','Titres','Songs','Brani','Músicas'],
 ['Playlists','Playlists','Playlists','Playlists','Playlist','Playlists'],
 ['Playlist','Playlist','Playlist','Playlist','Playlist','Playlist'],
 ['Todos','All','Tout','Alle','Tutti','Todos'],
 ['Colección','Collection','Collection','Sammlung','Collezione','Coleção'],
 ['Colecciones','Collections','Collections','Sammlungen','Collezioni','Coleções'],
 ['Crear','Create','Créer','Erstellen','Crea','Criar'],
 ['Crear playlist','Create playlist','Créer une playlist','Playlist erstellen','Crea playlist','Criar playlist'],
 ['Nueva playlist','New playlist','Nouvelle playlist','Neue Playlist','Nuova playlist','Nova playlist'],
 ['Mezclar','Shuffle','Lecture aléatoire','Zufallswiedergabe','Riproduzione casuale','Aleatório'],
 ['Reproducir','Play','Lire','Abspielen','Riproduci','Reproduzir'],
 ['Pausar','Pause','Pause','Pausieren','Pausa','Pausar'],
 ['Anterior','Previous','Précédent','Zurück','Precedente','Anterior'],
 ['Siguiente','Next','Suivant','Weiter','Successivo','Próximo'],
 ['Añadir a favoritos','Add to favorites','Ajouter aux favoris','Zu Favoriten hinzufügen','Aggiungi ai preferiti','Adicionar aos favoritos'],
 ['Quitar de favoritos','Remove from favorites','Retirer des favoris','Aus Favoriten entfernen','Rimuovi dai preferiti','Remover dos favoritos'],
 ['Añadir a playlist','Add to playlist','Ajouter à une playlist','Zur Playlist hinzufügen','Aggiungi a playlist','Adicionar à playlist'],
 ['Agregar a Playlist','Add to playlist','Ajouter à une playlist','Zur Playlist hinzufügen','Aggiungi a playlist','Adicionar à playlist'],
 ['Cancelar','Cancel','Annuler','Abbrechen','Annulla','Cancelar'],
 ['Cerrar','Close','Fermer','Schließen','Chiudi','Fechar'],
 ['Volver','Back','Retour','Zurück','Indietro','Voltar'],
 ['Guardar','Save','Enregistrer','Speichern','Salva','Salvar'],
 ['Eliminar','Delete','Supprimer','Löschen','Elimina','Excluir'],
 ['Importar','Import','Importer','Importieren','Importa','Importar'],
 ['Reintentar','Retry','Réessayer','Erneut versuchen','Riprova','Tentar novamente'],
 ['Limpiar','Clear','Effacer','Leeren','Cancella','Limpar'],
 ['Buscar música','Search music','Rechercher de la musique','Musik suchen','Cerca musica','Buscar músicas'],
 ['¿Qué quieres escuchar?','What do you want to listen to?','Que voulez-vous écouter ?','Was möchtest du hören?','Cosa vuoi ascoltare?','O que você quer ouvir?'],
 ['No se encontraron resultados','No results found','Aucun résultat','Keine Ergebnisse gefunden','Nessun risultato','Nenhum resultado encontrado'],
 ['Recientes','Recent','Récents','Zuletzt gehört','Recenti','Recentes'],
 ['Relevancia','Relevance','Pertinence','Relevanz','Rilevanza','Relevância'],
 ['Listo','Done','Terminé','Fertig','Fatto','Pronto'],
 ['Lista','Ready','Prête','Bereit','Pronta','Pronta'],
 ['Cargando...','Loading...','Chargement...','Wird geladen...','Caricamento...','Carregando...'],
 ['Sin pista cargada','No track loaded','Aucun titre chargé','Kein Song geladen','Nessun brano caricato','Nenhuma faixa carregada'],
 ['No hay canción seleccionada','No song selected','Aucun titre sélectionné','Kein Song ausgewählt','Nessun brano selezionato','Nenhuma música selecionada'],
 ['Discreto','Subtle','Discret','Dezent','Discreto','Discreto'],
 ['Cinemático','Cinematic','Cinématique','Filmisch','Cinematografico','Cinematográfico'],
 ['Suave','Soft','Doux','Sanft','Delicato','Suave'],
 ['Intenso','Intense','Intense','Intensiv','Intenso','Intenso'],
 ['Sólido','Solid','Opaque','Undurchsichtig','Opaco','Sólido'],
 ['Alta','High','Élevée','Hoch','Alta','Alta'],
 ['Baja','Low','Faible','Niedrig','Bassa','Baixa'],
 ['Equilibrado','Balanced','Équilibré','Ausgewogen','Bilanciato','Equilibrado'],
 ['Equilibrada','Balanced','Équilibrée','Ausgewogen','Bilanciata','Equilibrada'],
 ['Clásico','Classic','Classique','Klassisch','Classico','Clássico'],
 ['Activado','Enabled','Activé','Aktiviert','Attivato','Ativado'],
 ['Desactivado','Disabled','Désactivé','Deaktiviert','Disattivato','Desativado'],
 ['En vivo','Live','En direct','Live','Dal vivo','Ao vivo'],
 ['Tu colección','Your collection','Votre collection','Deine Sammlung','La tua collezione','Sua coleção'],
 ['Lista para sonar','Ready to play','Prête à jouer','Bereit zum Abspielen','Pronta per l’ascolto','Pronta para tocar'],
 ['Tu música, ordenada para volver a ella sin perder tiempo.','Your music, organized and within reach.','Votre musique, organisée et à portée de main.','Deine Musik, übersichtlich und griffbereit.','La tua musica, ordinata e a portata di mano.','Sua música, organizada e sempre à mão.'],
 ['Ponle ritmo a','Find the rhythm of','Donnez du rythme à','Gib deinem Moment','Dai ritmo al','Dê ritmo ao'],
 ['tu momento.','your moment.','votre moment.','deinen Rhythmus.','tuo momento.','seu momento.'],
 ['Retoma lo que estabas escuchando, encuentra una nueva canción o deja que Lunera elija por ti.','Pick up where you left off, discover a new song or let Lunera choose for you.','Reprenez votre écoute, découvrez un titre ou laissez Lunera choisir.','Höre weiter, entdecke neue Songs oder lass Lunera wählen.','Riprendi l’ascolto, scopri un brano o lascia scegliere Lunera.','Continue ouvindo, descubra uma música ou deixe o Lunera escolher.'],
 ['Nuevo','New','Nouveau','Neu','Nuovo','Novo'],
 ['Cerrar notificación','Dismiss notification','Fermer la notification','Benachrichtigung schließen','Chiudi notifica','Fechar notificação'],
 ['Algo salió mal','Something went wrong','Une erreur est survenue','Etwas ist schiefgelaufen','Qualcosa è andato storto','Algo deu errado'],
 ['Ten en cuenta','Please note','À noter','Bitte beachten','Nota bene','Atenção']
];

const languages = ['es', 'en', 'fr', 'de', 'it', 'pt'];
const catalog = new Map(rows.map(row => [row[0].toLocaleLowerCase('es'), row]));
function translate(source, language = 'es') {
  const index = languages.indexOf(language);
  if (index <= 0 || typeof source !== 'string') return source;
  const trimmed = source.trim();
  const row = catalog.get(trimmed.toLocaleLowerCase('es'));
  if (!row) return source;
  let result = row[index];
  if (trimmed.length > 1 && trimmed === trimmed.toLocaleUpperCase('es')) result = result.toLocaleUpperCase(language);
  return source.slice(0, source.indexOf(trimmed)) + result + source.slice(source.indexOf(trimmed) + trimmed.length);
}

if (typeof module !== 'undefined') module.exports = { translate, languages, rows };
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const originals = new WeakMap();
  const attributes = new WeakMap();
  let language = languages.includes(localStorage.getItem('language')) ? localStorage.getItem('language') : 'es';
  const skip = element => element?.closest('script,style,textarea,[contenteditable="true"],[data-no-translate],.track-title,.track-artist,.song-title,.song-artist,.playlist-name,#trackTitle,#trackArtist');
  const update = (node, source, store, key) => {
    const previous = store.get(key);
    const original = previous && source === previous.translated ? previous.original : source;
    const translated = translate(original, language);
    store.set(key, {original, translated});
    return translated;
  };
  let observer;
  function apply(root = document.body) {
    if (!root || !root.isConnected) return;
    observer?.disconnect();
    const languageSelect = document.getElementById('languageSelect');
    if (languageSelect) languageSelect.value = language;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = root.nodeType === Node.TEXT_NODE ? [root] : [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (skip(node.parentElement) || !node.data.trim()) continue;
      const value = update(node, node.data, originals, node);
      if (value !== node.data) node.data = value;
    }
    const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')] : [];
    for (const element of elements) {
      if (skip(element) || element.closest('#languageSelect')) continue;
      let records = attributes.get(element);
      if (!records) { records = new Map(); attributes.set(element, records); }
      for (const key of ['placeholder','title','aria-label']) {
        if (!element.hasAttribute(key)) continue;
        const source = element.getAttribute(key);
        const translated = update(element, source, records, key);
        if (source !== translated) element.setAttribute(key, translated);
      }
    }
    observer?.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['placeholder','title','aria-label']});
  }
  observer = new MutationObserver(records => {
    const roots = new Set();
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
      else roots.add(record.target);
    }
    roots.forEach(root => apply(root));
  });
  window.luneraI18n = {
    translate: source => translate(source, language),
    setLanguage(value) {
      language = languages.includes(value) ? value : 'es';
      localStorage.setItem('language', language);
      document.documentElement.lang = language;
      const select = document.getElementById('languageSelect');
      if (select) select.value = language;
      apply();
    },
    apply
  };
  document.addEventListener('change', event => {
    if (event.target.id === 'languageSelect') window.luneraI18n.setLanguage(event.target.value);
  }, true);
  window.addEventListener('storage', event => {
    if (event.key === 'language') window.luneraI18n.setLanguage(event.newValue);
  });
  window.luneraI18n.setLanguage(language);
}
})();
