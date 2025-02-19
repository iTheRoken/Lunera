self.addEventListener("install", (event) => {
    event.waitUntil(
      caches.open("mi-app-cache").then((cache) => {
        return cache.addAll([
          "index.html",
          "style.css",
          "main.js",
          "background.js",
          "renderer.js",
          "userData.json",
          "icon-192.png",
          "icon-512.png",
          
        ]);
      })
    );
  });
  
  self.addEventListener("fetch", (event) => {
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request);
      })
    );
  });
  