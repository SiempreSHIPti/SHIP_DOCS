
    // Google Places Autocomplete
    async function loadMaps() {
      try {
        const res = await fetch("/api/config");
        const { mapsKey } = await res.json();
        const mapsHelp = document.getElementById("maps-help");
        if (!mapsKey) {
          if (mapsHelp) {
            mapsHelp.textContent = "Google Maps no está configurado. Captura tu dirección completa manualmente.";
            mapsHelp.className = "maps-help warn";
          }
          return;
        }
        
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${mapsKey}&libraries=places&loading=async&callback=__gmapsReady`;
        script.async = true;
        script.defer = true;
        document.body.appendChild(script);
      } catch (e) {
        console.error("Error al cargar la API de Google Maps", e);
      }
    }

    function __gmapsReady() {
      const direccionInput = document.getElementById("direccion");
      const placeIdInput = document.getElementById("direccion_place_id");
      const latInput = document.getElementById("direccion_lat");
      const lngInput = document.getElementById("direccion_lng");
      const mapsHelp = document.getElementById("maps-help");
      if (!direccionInput) return;

      if (google.maps && google.maps.places && google.maps.places.Autocomplete) {
        mapsAutocompleteReady = true;
        if (mapsHelp) {
          mapsHelp.textContent = "Busca y selecciona una opción de Google Maps.";
          mapsHelp.className = "maps-help warn";
        }

        const unpatchedWarn = console.warn;
        console.warn = function(...args) {
          if (args[0] && typeof args[0] === 'string' && args[0].includes('google.maps.places.Autocomplete')) return;
          unpatchedWarn.apply(console, args);
        };

        const autocomplete = new google.maps.places.Autocomplete(direccionInput, {
          types: ["geocode"],
          componentRestrictions: { country: "mx" },
          fields: ["formatted_address", "geometry", "place_id", "name", "address_components"]
        });

        direccionInput.addEventListener("input", () => {
          if (placeIdInput) placeIdInput.value = "";
          if (latInput) latInput.value = "";
          if (lngInput) lngInput.value = "";
          if (mapsHelp) {
            mapsHelp.textContent = "Selecciona una opción de Google Maps para confirmar la dirección.";
            mapsHelp.className = "maps-help warn";
          }
        });

        autocomplete.addListener('place_changed', function () {
          const place = autocomplete.getPlace();
          if (!place || !place.geometry) {
            if (mapsHelp) {
              mapsHelp.textContent = "No pudimos confirmar esa dirección. Selecciona una opción de Google Maps.";
              mapsHelp.className = "maps-help warn";
            }
            return;
          }

          direccionInput.value = place.formatted_address || place.name || direccionInput.value;
          if (placeIdInput) placeIdInput.value = place.place_id || "";
          if (latInput) latInput.value = String(place.geometry.location.lat());
          if (lngInput) lngInput.value = String(place.geometry.location.lng());
          if (mapsHelp) {
            mapsHelp.textContent = "Dirección confirmada con Google Maps.";
            mapsHelp.className = "maps-help ok";
          }
        });

        setTimeout(() => { console.warn = unpatchedWarn; }, 2000);
      }
    }
    window.__gmapsReady = __gmapsReady;
    loadMaps();
  