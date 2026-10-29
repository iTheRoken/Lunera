/* ========================================
   NOTIFICATION SYSTEM
   ======================================== */

class NotificationSystem {
  constructor() {
    this.notifications = new Map();
    this.timers = new Map();
    this.audioContext = null;
    this.sounds = {};
    this.init();
  }

  init() {
    this.initAudio();
    this.createContainer();
    console.log('🔔 Sistema de notificaciones inicializado');
  }

  initAudio() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.createSounds();
    } catch (error) {
      console.warn('No se pudo inicializar el sistema de audio:', error);
    }
  }

  createSounds() {
    const soundConfigs = {
      success: { frequencies: [800, 1000, 1200], duration: 0.3, volume: 0.2 },
      error: { frequencies: [400, 300, 200], duration: 0.4, volume: 0.25 },
      warning: { frequencies: [600, 800], duration: 0.5, volume: 0.22 },
      info: { frequencies: [500, 700], duration: 0.25, volume: 0.18 }
    };

    Object.keys(soundConfigs).forEach(type => {
      this.sounds[type] = soundConfigs[type];
    });
  }

  createContainer() {
    if (document.getElementById('notification-container')) return;
    
    const container = document.createElement('div');
    container.id = 'notification-container';
    container.setAttribute('aria-label', 'Notificaciones');
    document.body.appendChild(container);
  }

  playSound(type) {
    if (!this.audioContext || !this.sounds[type]) return;

    try {
      const config = this.sounds[type];
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      const filterNode = this.audioContext.createBiquadFilter();

      filterNode.type = 'lowpass';
      filterNode.frequency.setValueAtTime(2000, this.audioContext.currentTime);

      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(config.volume, this.audioContext.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + config.duration);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(config.frequencies[0], this.audioContext.currentTime);
      
      config.frequencies.forEach((freq, index) => {
        const time = this.audioContext.currentTime + (index * 0.1);
        oscillator.frequency.setValueAtTime(freq, time);
      });

      oscillator.connect(filterNode);
      filterNode.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + config.duration);
    } catch (error) {
      console.warn(`Error al reproducir sonido ${type}:`, error);
    }
  }

  show(message, type = 'info', options = {}) {
    if (localStorage.getItem('notificationsEnabled') === 'false' && !options.force) return null;
    type = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    const id = `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : 5000;
    const playSound = options.playSound !== false;

    // Crear elemento de notificación
    const notification = document.createElement('div');
    notification.id = id;
    notification.className = `notification notification--${type}`;
    
    const symbols = { success: '✓', error: '×', warning: '!', info: 'i' };
    notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
    notification.innerHTML = `<div class="notification-content"><span class="notification-icon" aria-hidden="true">${symbols[type]}</span><div class="notification-copy"><span class="notification-title"></span><span class="notification-message"></span></div><button class="notification-close" aria-label="Cerrar notificación">×</button></div><div class="notification-lifetime" aria-hidden="true"></div>`;
    notification.querySelector('.notification-title').textContent = {success:'Listo',error:'Algo salió mal',warning:'Ten en cuenta',info:'Lunera'}[type];
    notification.querySelector('.notification-message').textContent = String(message);
    notification.querySelector('.notification-close').addEventListener('click', () => this.hide(id));
    notification.style.setProperty('--notification-duration', `${duration}ms`);
    if (!duration) notification.classList.add('notification--persistent');

    // Agregar al contenedor
    const container = document.getElementById('notification-container');
    container.appendChild(notification);

    // Guardar referencia
    this.notifications.set(id, notification);
    const active = [...this.notifications.keys()].filter(key => !this.notifications.get(key).classList.contains('notification--hide'));
    if (active.length > 4) this.hide(active[0]);

    // Reproducir sonido
    if (playSound) {
      this.playSound(type);
    }

    // Animar entrada
    requestAnimationFrame(() => {
      if (!notification.classList.contains('notification--hide')) notification.classList.add('notification--show');
    });

    let remaining = duration;
    let startedAt;
    const resume = () => {
      if (!duration || this.timers.has(id) || notification.classList.contains('notification--hide')) return;
      startedAt = performance.now();
      this.timers.set(id, setTimeout(() => this.hide(id), remaining));
      notification.classList.remove('notification--paused');
    };
    const pause = () => {
      if (!this.timers.has(id)) return;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
      notification.classList.add('notification--paused');
    };
    notification.addEventListener('pointerenter', pause);
    notification.addEventListener('pointerleave', () => { if (!notification.contains(document.activeElement)) resume(); });
    notification.addEventListener('focusin', pause);
    notification.addEventListener('focusout', () => { if (!notification.matches(':hover')) resume(); });
    resume();

    return id;
  }

  hide(id) {
    const notification = this.notifications.get(id);
    if (!notification || notification.classList.contains('notification--hide')) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);

    notification.classList.remove('notification--show');
    notification.classList.add('notification--hide');

    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
      this.notifications.delete(id);
    }, 400);
  }

  hideAll() {
    this.notifications.forEach((notification, id) => {
      this.hide(id);
    });
  }

  // Métodos de conveniencia
  success(message, options = {}) {
    return this.show(message, 'success', options);
  }

  error(message, options = {}) {
    return this.show(message, 'error', options);
  }

  warning(message, options = {}) {
    return this.show(message, 'warning', options);
  }

  info(message, options = {}) {
    return this.show(message, 'info', options);
  }
}

// Crear instancia global
const notificationSystem = new NotificationSystem();

// Función global para compatibilidad
function showNotification(message, type = 'info', options = {}) {
  return notificationSystem.show(message, type, options);
}

// Funciones de conveniencia globales
window.notify = {
  success: (message, options) => notificationSystem.success(message, options),
  error: (message, options) => notificationSystem.error(message, options),
  warning: (message, options) => notificationSystem.warning(message, options),
  info: (message, options) => notificationSystem.info(message, options),
  hide: (id) => notificationSystem.hide(id),
  hideAll: () => notificationSystem.hideAll()
};

// Funciones de prueba
window.testNotifications = () => {
  console.log('🔔 Probando sistema de notificaciones');
  notificationSystem.success('¡Notificación de éxito!');
  setTimeout(() => notificationSystem.error('Error de prueba'), 1000);
  setTimeout(() => notificationSystem.warning('Advertencia de prueba'), 2000);
  setTimeout(() => notificationSystem.info('Información de prueba'), 3000);
};

window.testNotificationSystem = () => {
  console.log('🔔 Probando sistema completo');
  const id1 = notificationSystem.success('Primera notificación', { duration: 2000 });
  setTimeout(() => notificationSystem.error('Segunda notificación'), 500);
  setTimeout(() => notificationSystem.warning('Tercera notificación'), 1000);
  setTimeout(() => notificationSystem.info('Cuarta notificación'), 1500);
};

console.log('🔔 Sistema de notificaciones cargado');
