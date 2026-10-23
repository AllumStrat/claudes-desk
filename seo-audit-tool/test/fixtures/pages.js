export const goodPage = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brake Repair in Mesa, AZ | Floorjack Auto Repair</title>
<meta name="description" content="Fast, honest brake repair in Mesa, AZ. Same-day service, free inspections and a 24 month warranty on every brake job. Call or book online today.">
<link rel="canonical" href="https://shop.example.com/brakes">
<link rel="icon" href="/favicon.ico">
<meta property="og:title" content="Brake Repair in Mesa">
<meta property="og:description" content="Same-day brake repair in Mesa.">
<meta property="og:image" content="https://shop.example.com/og.jpg">
<meta property="og:url" content="https://shop.example.com/brakes">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoRepair","name":"Floorjack Auto Repair","url":"https://shop.example.com","telephone":"+1-480-555-0142","image":"https://shop.example.com/logo.png","geo":{"@type":"GeoCoordinates","latitude":33.4,"longitude":-111.8},"openingHours":"Mo-Fr 08:00-17:00","address":{"@type":"PostalAddress","streetAddress":"123 Main St","addressLocality":"Mesa","addressRegion":"AZ","postalCode":"85201"}}</script>
</head>
<body>
<header><a href="/">Home</a> <a href="/services">Services</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="tel:+14805550142">(480) 555-0142</a></header>
<main>
<h1>Brake Repair in Mesa</h1>
<p>${'Our certified technicians inspect pads, rotors, calipers and fluid on every visit and explain what they find before any work starts. '.repeat(30)}</p>
<h2>What we check</h2>
<img src="/img/brakes.webp" alt="Technician replacing brake pads" width="800" height="600" loading="lazy">
<h2>Visit us</h2>
<p>123 Main St, Mesa, AZ 85201. Read our reviews from Mesa drivers.</p>
<a href="https://maps.example.org/place">Directions</a>
</main>
</body>
</html>`;

export const badPage = `<html><head>
<script src="/js/jquery.js"></script>
<script src="/js/a.js"></script>
<script src="/js/b.js"></script>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="https://other.example.net/">
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Organization",}</script>
</head><body>
<h1>Welcome</h1><h1>Hello</h1><h3>Skip</h3><h2></h2>
<img src="http://cdn.example.com/hero.jpg">
<p>Call 480-555-0199 today.</p>
<a href="/broken">click here</a>
<a href="/a"></a>
</body></html>`;
