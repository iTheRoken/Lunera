// ========================================
// CSP Configuration for Lunera
// ========================================

// Función para configurar CSP dinámicamente
function configureCSP() {
    // Verificar si ya existe una meta tag CSP
    let existingCSP = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    
    if (existingCSP) {
        // Actualizar CSP existente
        existingCSP.setAttribute('content', 
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
            "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
            "img-src 'self' data: https:; " +
            "media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; " +
            "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; " +
            "object-src 'none'; " +
            "base-uri 'self'; " +
            "form-action 'self';"
        );
    } else {
        // Crear nueva meta tag CSP
        const meta = document.createElement('meta');
        meta.setAttribute('http-equiv', 'Content-Security-Policy');
        meta.setAttribute('content', 
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
            "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
            "img-src 'self' data: https:; " +
            "media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; " +
            "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; " +
            "object-src 'none'; " +
            "base-uri 'self'; " +
            "form-action 'self';"
        );
        document.head.appendChild(meta);
    }
    
    console.log('🔒 CSP configurado para Lunera');
}

// Función para remover scripts inline problemáticos
function removeInlineScripts() {
    // Buscar y remover scripts inline que causan problemas de CSP
    const scripts = document.querySelectorAll('script');
    scripts.forEach(script => {
        if (script.innerHTML && script.innerHTML.includes('__CF$cv$params')) {
            console.log('🗑️ Removiendo script inline problemático');
            script.remove();
        }
    });
}

// Función para cargar fuentes de Google de forma segura
function loadGoogleFonts() {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = 'https://fonts.googleapis.com';
    document.head.appendChild(link);
    
    const link2 = document.createElement('link');
    link2.rel = 'preconnect';
    link2.href = 'https://fonts.gstatic.com';
    link2.crossOrigin = 'anonymous';
    document.head.appendChild(link2);
    
    const fontLink = document.createElement('link');
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap';
    fontLink.rel = 'stylesheet';
    document.head.appendChild(fontLink);
    
    console.log('🔤 Fuentes de Google cargadas');
}

// Función para manejar errores de recursos
function handleResourceErrors() {
    // Interceptar errores de recursos
    window.addEventListener('error', (e) => {
        if (e.target.tagName === 'IMG' || e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO') {
            // Solo mostrar errores para recursos importantes
            const src = e.target.src || e.target.href || '';
            const isLocalAudioProxy = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/audio\//i.test(src);
            if (src && !isLocalAudioProxy && !src.includes('cdn-cgi') && !src.includes('yt3.ggpht.com')) {
                console.log(`🔇 Recurso no encontrado: ${e.target.src || e.target.href}`);
            }
            e.preventDefault();
            return false;
        }
    }, true);
    
    // Interceptar errores de scripts
    window.addEventListener('error', (e) => {
        if (e.filename && e.filename.includes('cdn-cgi')) {
            e.preventDefault();
            return false;
        }
    }, true);
}

// Función para arreglar warnings de CSS
function fixCSSWarnings() {
    // Agregar estilos para arreglar warnings de appearance
    const style = document.createElement('style');
    style.textContent = `
        /* Arreglar warnings de appearance - usar método moderno */
        .equalizer-slider input,
        .modern-slider {
            writing-mode: vertical-lr;
            direction: rtl;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
        }
        
        /* Estilos adicionales para sliders verticales */
        .equalizer-slider input[type="range"],
        .modern-slider[type="range"] {
            writing-mode: vertical-lr;
            direction: rtl;
            transform: rotate(180deg);
        }
    `;
    document.head.appendChild(style);
    console.log('🎨 Warnings de CSS arreglados');
}

// Función principal de inicialización
function initializeCSP() {
    try {
        configureCSP();
        removeInlineScripts();
        loadGoogleFonts();
        handleResourceErrors();
        fixCSSWarnings();
        console.log('✅ Configuración CSP completada');
    } catch (e) {
        console.warn('⚠️ Error al configurar CSP:', e);
    }
}

// Exportar funciones
window.CSPConfig = {
    configureCSP,
    removeInlineScripts,
    loadGoogleFonts,
    handleResourceErrors,
    fixCSSWarnings,
    initializeCSP
};

// Auto-inicializar si el DOM está listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeCSP);
} else {
    initializeCSP();
}

