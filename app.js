/* ===== Al-Balad Interactive Map — Application Logic ===== */

(function () {
  'use strict';

  // ─── Configuration ───────────────────────────────────────
  const MAP_CENTER = [21.4863, 39.1860]; // Al-Balad, Jeddah
  const MAP_ZOOM = 19;
  const SNAP_TOLERANCE = 0.00001; // ~15m in degrees at this latitude

  // POI type mapping
  const POI_TYPES = {
    res: { label: 'Restaurant', emoji: '🍽️', cssClass: 'restaurant' },
    rest: { label: 'Restaurant', emoji: '🍽️', cssClass: 'restaurant' },
    coffe: { label: 'Coffee Shop', emoji: '☕', cssClass: 'coffee' },
    m: { label: 'Mosque', emoji: '🕌', cssClass: 'mosque' },
  };

  function getPoiType(typeCode) {
    return POI_TYPES[typeCode] || { label: typeCode || 'Place', emoji: '📍', cssClass: 'default-type' };
  }

  // ─── State ───────────────────────────────────────────────
  let map;
  let alleyLayer, poiLayer, routeLayer;
  let poiData = [];
  let alleyData = null;
  let graph = null; // adjacency graph for routing
  let currentFilter = 'all';

  // ─── Map Initialization ──────────────────────────────────
  function initMap() {
    map = L.map('map', {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      zoomControl: false,
      attributionControl: true,
    });

    // Base map layers
    const darkMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 22,
    });

    const lightMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 22,
    });

    const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 22,
    });

    // Add dark map as default
    darkMap.addTo(map);

    // Layer control
    const baseMaps = {
      '🌑 Dark': darkMap,
      '☀️ Light': lightMap,
      '🛰️ Satellite': satelliteMap,
    };

    L.control.layers(baseMaps, null, {
      position: 'topright',
      collapsed: true,
    }).addTo(map);

    // Zoom control top-right
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Route layer (on top)
    routeLayer = L.layerGroup().addTo(map);
  }

  // ─── Load GeoJSON Data ───────────────────────────────────
  async function loadData() {
    const [alleyRes, poiRes] = await Promise.all([
      fetch('Allew_v2.geojson'),
      fetch('POI_v1.geojson'),
    ]);

    alleyData = await alleyRes.json();
    const poiGeojson = await poiRes.json();
    poiData = poiGeojson.features;

    renderAlleyLayer(alleyData);
    renderPoiLayer(poiGeojson);
    buildGraph(alleyData);
    populateSidebar();
    populateNavDropdowns();
  }

  // ─── Render Alley/Road Layer ─────────────────────────────
  function renderAlleyLayer(geojson) {
    alleyLayer = L.geoJSON(geojson, {
      style: function (feature) {
        const isRoad = feature.properties.Name && feature.properties.Name.toLowerCase() === 'road';
        return {
          color: isRoad ? '#f9a825' : '#4fc3f7',
          weight: isRoad ? 4 : 2.5,
          opacity: isRoad ? 0.85 : 0.55,
          dashArray: isRoad ? null : '6 4',
          lineCap: 'round',
          lineJoin: 'round',
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('mouseover', function () {
          this.setStyle({
            opacity: 1,
            weight: this.options.weight + 2,
          });
        });
        layer.on('mouseout', function () {
          alleyLayer.resetStyle(this);
        });

        const name = feature.properties.Name || 'Unnamed';
        layer.bindTooltip(name, {
          className: 'alley-tooltip',
          direction: 'top',
          offset: [0, -8],
        });
      },
    }).addTo(map);
  }

  // ─── Render POI Markers ──────────────────────────────────
  function renderPoiLayer(geojson) {
    poiLayer = L.geoJSON(geojson, {
      pointToLayer: function (feature, latlng) {
        const typeInfo = getPoiType(feature.properties.type);
        const marker = L.marker(latlng, {
          icon: createCustomIcon(typeInfo),
        });
        return marker;
      },
      onEachFeature: function (feature, layer) {
        const props = feature.properties;
        const typeInfo = getPoiType(props.type);

        const popupHtml = `
          <div class="popup-content">
            <div class="popup-name">${typeInfo.emoji} ${props.name}</div>
            <div class="popup-type">${typeInfo.label}</div>
            <div class="popup-actions">
              <button class="popup-action-btn primary" onclick="window.alBaladApp.setNavFrom(${props.poi_id})">Navigate From</button>
              <button class="popup-action-btn" onclick="window.alBaladApp.setNavTo(${props.poi_id})">Navigate To</button>
            </div>
          </div>
        `;
        layer.bindPopup(popupHtml, {
          maxWidth: 260,
          closeButton: true,
        });
      },
    }).addTo(map);
  }

  function createCustomIcon(typeInfo) {
    return L.divIcon({
      className: '',
      html: `<div class="custom-marker ${typeInfo.cssClass}">
               <span class="marker-emoji">${typeInfo.emoji}</span>
             </div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38],
      popupAnchor: [0, -40],
    });
  }

  // ─── Graph Construction (for routing) ────────────────────
  function buildGraph(geojson) {
    graph = {};

    // Convert all coordinates to graph nodes and edges
    geojson.features.forEach(function (feature) {
      const coords = feature.geometry.coordinates; // [lng, lat]
      for (let i = 0; i < coords.length - 1; i++) {
        const from = coordKey(coords[i]);
        const to = coordKey(coords[i + 1]);
        const dist = haversine(coords[i], coords[i + 1]);

        addEdge(from, to, dist, coords[i], coords[i + 1]);
        addEdge(to, from, dist, coords[i + 1], coords[i]);
      }
    });

    // Snap endpoints that are close to each other (intersection detection)
    const nodes = Object.keys(graph);
    for (let i = 0; i < nodes.length; i++) {
      if (!graph[nodes[i]]) continue; // ADDED: Skip if node i was already deleted

      for (let j = i + 1; j < nodes.length; j++) {
        if (!graph[nodes[j]]) continue; // ADDED: Skip if node j was already deleted

        const c1 = parseCoordKey(nodes[i]);
        const c2 = parseCoordKey(nodes[j]);
        const d = Math.sqrt(
          Math.pow(c1[0] - c2[0], 2) + Math.pow(c1[1] - c2[1], 2)
        );
        if (d < SNAP_TOLERANCE && d > 0) {
          // Merge nodes[j] into nodes[i]
          mergeNodes(nodes[j], nodes[i]);
        }
      }
    }
  }

  function coordKey(coord) {
    return coord[0].toFixed(8) + ',' + coord[1].toFixed(8);
  }

  function parseCoordKey(key) {
    const parts = key.split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }

  function addEdge(fromKey, toKey, distance, fromCoord, toCoord) {
    if (!graph[fromKey]) {
      graph[fromKey] = { coord: fromCoord, edges: [] };
    }
    graph[fromKey].edges.push({
      to: toKey,
      distance: distance,
      toCoord: toCoord,
    });
  }

  function mergeNodes(oldKey, newKey) {
    if (!graph[oldKey] || oldKey === newKey) return;

    // Move all edges from oldKey to newKey
    if (!graph[newKey]) {
      graph[newKey] = { coord: parseCoordKey(newKey), edges: [] };
    }

    graph[oldKey].edges.forEach(function (edge) {
      if (edge.to === oldKey) edge.to = newKey;
      if (edge.to !== newKey) {
        graph[newKey].edges.push(edge);
      }
    });

    // Update all references to oldKey in other nodes
    Object.keys(graph).forEach(function (nodeKey) {
      graph[nodeKey].edges.forEach(function (edge) {
        if (edge.to === oldKey) {
          edge.to = newKey;
        }
      });
    });

    delete graph[oldKey];
  }

  // ─── POI Snapping to Graph ──────────────────────────────
  function snapPoiToGraph(poiCoord) {
    // poiCoord is [lng, lat]
    let bestKey = null;
    let bestDist = Infinity;
    let bestPoint = null;
    let bestSegFrom = null;
    let bestSegTo = null;

    // Check each edge segment for closest point
    Object.keys(graph).forEach(function (nodeKey) {
      graph[nodeKey].edges.forEach(function (edge) {
        const fromCoord = graph[nodeKey].coord;
        const toCoord = edge.toCoord;

        const projected = projectPointOnSegment(poiCoord, fromCoord, toCoord);
        const dist = haversine(poiCoord, projected.point);

        if (dist < bestDist) {
          bestDist = dist;
          bestPoint = projected.point;
          bestKey = coordKey(projected.point);
          bestSegFrom = nodeKey;
          bestSegTo = edge.to;
        }
      });
    });

    // Insert projected point into the graph
    if (bestKey && !graph[bestKey]) {
      graph[bestKey] = { coord: bestPoint, edges: [] };

      // Connect to segment endpoints
      const dFrom = haversine(bestPoint, graph[bestSegFrom].coord);
      const dTo = haversine(bestPoint, graph[bestSegTo] ? graph[bestSegTo].coord : parseCoordKey(bestSegTo));

      addEdge(bestKey, bestSegFrom, dFrom, bestPoint, graph[bestSegFrom].coord);
      addEdge(bestSegFrom, bestKey, dFrom, graph[bestSegFrom].coord, bestPoint);

      if (graph[bestSegTo]) {
        addEdge(bestKey, bestSegTo, dTo, bestPoint, graph[bestSegTo].coord);
        addEdge(bestSegTo, bestKey, dTo, graph[bestSegTo].coord, bestPoint);
      }
    }

    return bestKey;
  }

  function projectPointOnSegment(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) return { point: a, t: 0 };

    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    return {
      point: [a[0] + t * dx, a[1] + t * dy],
      t: t,
    };
  }

  // ─── Dijkstra Shortest Path ──────────────────────────────
  function dijkstra(startKey, endKey) {
    if (!graph[startKey] || !graph[endKey]) return null;

    const dist = {};
    const prev = {};
    const visited = {};
    const queue = []; // simple priority queue

    Object.keys(graph).forEach(function (key) {
      dist[key] = Infinity;
      prev[key] = null;
    });

    dist[startKey] = 0;
    queue.push({ key: startKey, dist: 0 });

    while (queue.length > 0) {
      // Find minimum
      queue.sort(function (a, b) {
        return a.dist - b.dist;
      });
      const current = queue.shift();

      if (visited[current.key]) continue;
      visited[current.key] = true;

      if (current.key === endKey) break;

      if (!graph[current.key]) continue;

      graph[current.key].edges.forEach(function (edge) {
        if (visited[edge.to]) return;
        const newDist = dist[current.key] + edge.distance;
        if (newDist < dist[edge.to]) {
          dist[edge.to] = newDist;
          prev[edge.to] = current.key;
          queue.push({ key: edge.to, dist: newDist });
        }
      });
    }

    if (dist[endKey] === Infinity) return null;

    // Reconstruct path
    const path = [];
    let current = endKey;
    while (current !== null) {
      path.unshift(parseCoordKey(current));
      current = prev[current];
    }

    return {
      path: path, // Array of [lng, lat]
      distance: dist[endKey], // in meters
    };
  }

  // ─── Haversine Distance ──────────────────────────────────
  function haversine(coord1, coord2) {
    // coord1, coord2 are [lng, lat]
    const R = 6371000; // Earth radius in meters
    const lat1 = (coord1[1] * Math.PI) / 180;
    const lat2 = (coord2[1] * Math.PI) / 180;
    const dlat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
    const dlng = ((coord2[0] - coord1[0]) * Math.PI) / 180;

    const a =
      Math.sin(dlat / 2) * Math.sin(dlat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) * Math.sin(dlng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // ─── Navigation ──────────────────────────────────────────
  function navigate() {
    const fromSelect = document.getElementById('nav-from');
    const toSelect = document.getElementById('nav-to');

    const fromId = parseInt(fromSelect.value);
    const toId = parseInt(toSelect.value);

    if (!fromId || !toId || fromId === toId) {
      showRouteError('Please select different origin and destination.');
      return;
    }

    const fromPoi = poiData.find(function (f) { return f.properties.poi_id === fromId; });
    const toPoi = poiData.find(function (f) { return f.properties.poi_id === toId; });

    if (!fromPoi || !toPoi) return;

    // Re-build graph to clear previous snapped points
    buildGraph(alleyData);

    const fromCoord = fromPoi.geometry.coordinates;
    const toCoord = toPoi.geometry.coordinates;

    const fromKey = snapPoiToGraph(fromCoord);
    const toKey = snapPoiToGraph(toCoord);

    const result = dijkstra(fromKey, toKey);

    if (!result) {
      showRouteError('No route found between these locations.');
      return;
    }

    renderRoute(result, fromPoi.properties, toPoi.properties);
  }

  function renderRoute(result, fromProps, toProps) {
    routeLayer.clearLayers();

    // Convert path [lng, lat] to [lat, lng] for Leaflet
    const latLngs = result.path.map(function (c) {
      return [c[1], c[0]];
    });

    // Glow effect (wider, transparent line behind)
    L.polyline(latLngs, {
      color: '#4fc3f7',
      weight: 12,
      opacity: 0.2,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(routeLayer);

    // Main route line
    const routeLine = L.polyline(latLngs, {
      color: '#4fc3f7',
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: '10 6',
      className: 'route-line-animated',
    }).addTo(routeLayer);

    // Start marker
    L.circleMarker(latLngs[0], {
      radius: 8,
      fillColor: '#66bb6a',
      fillOpacity: 1,
      color: '#fff',
      weight: 2,
    }).addTo(routeLayer).bindTooltip('Start: ' + fromProps.name, { permanent: false, direction: 'top' });

    // End marker
    L.circleMarker(latLngs[latLngs.length - 1], {
      radius: 8,
      fillColor: '#f9a825',
      fillOpacity: 1,
      color: '#fff',
      weight: 2,
    }).addTo(routeLayer).bindTooltip('End: ' + toProps.name, { permanent: false, direction: 'top' });

    // Fit bounds
    map.fitBounds(routeLine.getBounds().pad(0.3));

    // Show route result card
    showRouteResult(result, fromProps, toProps);
  }

  function showRouteResult(result, fromProps, toProps) {
    const resultDiv = document.getElementById('route-result');
    const fromType = getPoiType(fromProps.type);
    const toType = getPoiType(toProps.type);
    const distanceM = Math.round(result.distance);
    const walkMinutes = Math.max(1, Math.round(distanceM / 80)); // ~80m/min walking

    resultDiv.innerHTML = `
      <div class="route-header">
        <span class="route-title">🗺️ Route Found</span>
      </div>
      <div class="route-stats">
        <div class="route-stat">
          <div class="stat-value">${distanceM}</div>
          <div class="stat-label">meters</div>
        </div>
        <div class="route-stat">
          <div class="stat-value">~${walkMinutes}</div>
          <div class="stat-label">min walk</div>
        </div>
      </div>
      <div class="route-steps">
        <div class="route-step">
          <div class="step-dot start"></div>
          <div class="step-text"><strong>${fromType.emoji} ${fromProps.name}</strong><br/>${fromType.label}</div>
        </div>
        <div class="route-step">
          <div class="step-dot via"></div>
          <div class="step-text">Walk through Al-Balad alleys<br/><em>${distanceM}m via ${result.path.length - 2} waypoints</em></div>
        </div>
        <div class="route-step">
          <div class="step-dot end"></div>
          <div class="step-text"><strong>${toType.emoji} ${toProps.name}</strong><br/>${toType.label}</div>
        </div>
      </div>
    `;
    resultDiv.classList.add('visible');
  }

  function showRouteError(msg) {
    const resultDiv = document.getElementById('route-result');
    resultDiv.innerHTML = `
      <div class="route-header">
        <span class="route-title" style="color: var(--danger);">⚠️ ${msg}</span>
      </div>
    `;
    resultDiv.classList.add('visible');
  }

  function clearRoute() {
    routeLayer.clearLayers();
    document.getElementById('route-result').classList.remove('visible');
    document.getElementById('route-result').innerHTML = '';
    document.getElementById('nav-from').value = '';
    document.getElementById('nav-to').value = '';
  }

  // ─── Sidebar: POI List ───────────────────────────────────
  function populateSidebar() {
    renderPoiList(poiData);
  }

  function renderPoiList(features) {
    const list = document.getElementById('poi-list');
    list.innerHTML = '';

    const filtered = features.filter(function (f) {
      if (currentFilter === 'all') return true;
      // Treat 'res' and 'rest' both as restaurant
      if (currentFilter === 'res') {
        return f.properties.type === 'res' || f.properties.type === 'rest';
      }
      return f.properties.type === currentFilter;
    });

    const searchTerm = document.getElementById('search-input').value.toLowerCase().trim();
    const searched = filtered.filter(function (f) {
      if (!searchTerm) return true;
      return f.properties.name.toLowerCase().includes(searchTerm);
    });

    if (searched.length === 0) {
      list.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <p>No places found</p>
        </div>
      `;
      return;
    }

    searched.forEach(function (feature) {
      const props = feature.properties;
      const typeInfo = getPoiType(props.type);

      const card = document.createElement('div');
      card.className = 'poi-card';
      card.setAttribute('data-poi-id', props.poi_id);
      card.innerHTML = `
        <div class="poi-icon ${typeInfo.cssClass}">${typeInfo.emoji}</div>
        <div class="poi-info">
          <div class="poi-name">${props.name}</div>
          <div class="poi-type">${typeInfo.label}</div>
        </div>
        <div class="poi-arrow">→</div>
      `;

      card.addEventListener('click', function () {
        const coords = feature.geometry.coordinates;
        map.flyTo([coords[1], coords[0]], 20, { duration: 0.8 });

        // Open popup on the marker
        poiLayer.eachLayer(function (layer) {
          if (layer.feature && layer.feature.properties.poi_id === props.poi_id) {
            layer.openPopup();
          }
        });
      });

      list.appendChild(card);
    });
  }

  // ─── Sidebar: Navigation Dropdowns ───────────────────────
  function populateNavDropdowns() {
    const fromSelect = document.getElementById('nav-from');
    const toSelect = document.getElementById('nav-to');

    // Clear existing options (keep first placeholder)
    fromSelect.innerHTML = '<option value="">Select starting point…</option>';
    toSelect.innerHTML = '<option value="">Select destination…</option>';

    poiData.forEach(function (feature) {
      const props = feature.properties;
      const typeInfo = getPoiType(props.type);

      const optFrom = document.createElement('option');
      optFrom.value = props.poi_id;
      optFrom.textContent = typeInfo.emoji + ' ' + props.name;
      fromSelect.appendChild(optFrom);

      const optTo = document.createElement('option');
      optTo.value = props.poi_id;
      optTo.textContent = typeInfo.emoji + ' ' + props.name;
      toSelect.appendChild(optTo);
    });
  }

  // ─── Public API (for popup buttons) ──────────────────────
  window.alBaladApp = {
    setNavFrom: function (poiId) {
      document.getElementById('nav-from').value = poiId;
      switchTab('navigate');
      map.closePopup();
    },
    setNavTo: function (poiId) {
      document.getElementById('nav-to').value = poiId;
      switchTab('navigate');
      map.closePopup();
    },
  };

  // ─── Tab Switching ───────────────────────────────────────
  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'panel-' + tabName);
    });
  }

  // ─── Event Bindings ──────────────────────────────────────
  function bindEvents() {
    // Sidebar toggle
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');

    toggle.addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      toggle.classList.toggle('shifted');
      toggle.innerHTML = sidebar.classList.contains('collapsed') ? '☰' : '✕';
      // Re-invalidate map size after animation
      setTimeout(function () {
        map.invalidateSize();
      }, 350);
    });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(this.dataset.tab);
      });
    });

    // Search
    document.getElementById('search-input').addEventListener('input', function () {
      renderPoiList(poiData);
    });

    // Filter chips
    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        currentFilter = this.dataset.filter;
        document.querySelectorAll('.chip').forEach(function (c) {
          c.classList.toggle('active', c.dataset.filter === currentFilter);
        });
        renderPoiList(poiData);
      });
    });

    // Navigate button
    document.getElementById('navigate-btn').addEventListener('click', navigate);

    // Swap button
    document.getElementById('swap-btn').addEventListener('click', function () {
      const fromSelect = document.getElementById('nav-from');
      const toSelect = document.getElementById('nav-to');
      const temp = fromSelect.value;
      fromSelect.value = toSelect.value;
      toSelect.value = temp;
    });

    // Clear route
    document.getElementById('clear-route-btn').addEventListener('click', clearRoute);
  }

  // ─── Loading Screen ──────────────────────────────────────
  function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hidden');
    setTimeout(function () {
      overlay.remove();
    }, 600);
  }

  // ─── Bootstrap ───────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {
    initMap();
    bindEvents();

    try {
      await loadData();
    } catch (err) {
      console.error('Failed to load map data:', err);
    }

    hideLoading();
  });
})();
