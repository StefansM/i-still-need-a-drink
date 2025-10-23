"use strict";

const STATUS_CLASSES = ["info", "error"];

function coordStr(loc) {
    return `${loc.latitude},${loc.longitude}`;
}

function degToRad(deg) {
    return deg * Math.PI / 180;
}

function haversineFunc(theta) {
    return (1 - Math.cos(degToRad(theta))) / 2;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const haversineGcd = haversineFunc(lat2 - lat1) + (
            Math.cos(degToRad(lat1)) *
            Math.cos(degToRad(lat2)) *
            haversineFunc(lon2 - lon1)
    );
    const gcd = Math.asin(Math.sqrt(haversineGcd));
    const radiusMeters = 6371e3;
    return 2 * radiusMeters * gcd;
}

function bearingBetween(lat1, lon1, lat2, lon2) {
    const y = Math.sin(degToRad(lon2-lon1)) * Math.cos(degToRad(lat2));
    const x = Math.cos(degToRad(lat1)) * Math.sin(degToRad(lat2)) -
        Math.sin(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.cos(degToRad(lon2 - lon1));
    const theta = Math.atan2(y, x);
    const bearing = (theta * 180 / Math.PI + 360) % 360;
    return bearing;
}

class Application {
    constructor() {
        this.statusPane = this.getElemOrFail("status");
        this.compassDiv = this.getElemOrFail("compass");
        this.distanceDiv = this.getElemOrFail("distance");
        this.nameDiv = this.getElemOrFail("name");
        this.pubListElem = this.getElemOrFail("list");

        if (!("geolocation" in navigator)) {
            this.setStatus("Geolocation not available.", "error", true);
        }

        this.currentLocation = null;
        this.currentHeading = null;
        this.nearbyPubs = null;
        this.selectedPubId = null;

        this._pendingFetch = null;
        this._onHeading = this.setHeading.bind(this);

        this.setStatus("Fetching location", "info");
        addEventListener("deviceorientationabsolute", this._onHeading);
        this.watchId = navigator.geolocation.watchPosition(this.setCoords.bind(this));
    }

    getElemOrFail(elemId) {
        const elem = document.getElementById(elemId);
        if (elem === null) {
            this.setStatus(`Fatal: Could not locate #${elemid}.`, "error", true);
        }
        return elem;
    }

    setHeading(orientationEvent) {
        this.currentHeading = 360 - orientationEvent.alpha;
        this.updateBearingUI();
        // console.debug("Current heading", this.currentHeading);
    }

    setCoords(position) {
        const oldCoords = this.currentLocation;
        this.currentLocation = position.coords;
        console.debug("Current coords", this.currentLocation);
        this.updateUI();

        if (oldCoords !== null) {
            const distanceChange = haversineDistance(
                this.currentLocation.latitude, this.currentLocation.longitude,
                oldCoords.latitude, oldCoords.longitude
            );
            if (distanceChange < 250) {
                return;
            }
        }
        if (!this._pendingFetch) {
            this._pendingFetch = this.fetchNearbyPubs().finally(() => {this._pendingFetch = null;});
        }
    }

    async fetchNearbyPubs() {
        this.setStatus("Fetching nearby pubs", "info");

        const overPassQuery = `[out:json][timeout:25];\n`
            + `nwr["amenity"="pub"]`
            + `(around:3000,${this.currentLocation.latitude},${this.currentLocation.longitude});\n`
            + `out center;\n`;
        const params = new URLSearchParams();
        params.append("data", overPassQuery);

        const response = await fetch(`https://overpass-api.de/api/interpreter?${params}`);
        if (!response.ok) {
            this.setStatus(`Error fetching local pubs: ${response.status}`, "error", false);
            return;
        }
        const json = await response.json();
        const results = (json?.elements ?? []).map(r => {
            if ("center" in r) {
                return {
                    latitude: r["center"]["lat"],
                    longitude: r["center"]["lon"],
                    name: r["tags"]["name"],
                    id: r["id"],
                };
            } else {
                return {
                    latitude: r["lat"],
                    longitude: r["lon"],
                    name: r["tags"]["name"],
                    id: r["id"],
                };
            }
        });
        this.nearbyPubs = results;
        this.updateUI();

        console.debug("Fetched pubs: ", this.nearbyPubs);
    }

    selectedPub() {
        if (this.selectedPubId) {
            const pub = this.nearbyPubs.find((p) => p.id === this.selectedPubId);
            if (pub !== undefined) {
                return pub;
            }
        }

        const pubs = this.nearbyPubs.toSorted(this.#distanceSort.bind(this));
        const closestPub = pubs[0];
        return closestPub;
    }

    #distanceSort(pub1, pub2) {
        const d1 = haversineDistance(
            this.currentLocation.latitude,
            this.currentLocation.longitude,
            pub1.latitude,
            pub1.longitude
        );
        const d2 = haversineDistance(
            this.currentLocation.latitude,
            this.currentLocation.longitude,
            pub2.latitude,
            pub2.longitude
        );
        return d1 - d2;
    }

    updateBearingUI() {
        if (!this.currentLocation || this.nearbyPubs === null || this.nearbyPubs.length === 0) {
            return;
        }
        const ourLat = this.currentLocation.latitude;
        const ourLon = this.currentLocation.longitude;

        const closestPub = this.selectedPub();

        const bearing = bearingBetween(ourLat, ourLon, closestPub.latitude, closestPub.longitude);

        const relBearing = (bearing - this.currentHeading + 360) % 360;
        const shortRelBearing = ((relBearing + 540) % 360) - 180;

        this.compassDiv.style.transform = `rotate(${shortRelBearing}deg)`;
    }

    updateUI() {
        if (!this.currentLocation || this.nearbyPubs === null || this.nearbyPubs.length === 0) {
            return;
        }
        this.clearStatus();
        this.compassDiv.style.display = "block";
        this.distanceDiv.style.display = "block";

        const ourLat = this.currentLocation.latitude;
        const ourLon = this.currentLocation.longitude;

        const closestPub = this.selectedPub();

        const distance = haversineDistance(ourLat, ourLon, closestPub.latitude, closestPub.longitude);

        this.setDistance(distance);
        this.setName(closestPub);
        this.setNearbyPubsDisplay();

        this.updateBearingUI();
    }

    setNearbyPubsDisplay() {
        const lat = this.currentLocation.latitude;
        const lon = this.currentLocation.longitude;

        const elem = this.pubListElem;
        const createLinkElem = (pub) => {
            const distance = haversineDistance(lat, lon, pub.latitude, pub.longitude);
            const distanceStr = this.distanceStr(distance);

            const li = document.createElement("li");
            const input = document.createElement("input")
            input.setAttribute("name", "selected-pub");
            input.setAttribute("type", "radio");
            if (this.selectedPubId === pub.id) {
                input.setAttribute("checked", "true");
            }

            input.addEventListener("change", (event) => {
                this.selectedPubId = pub.id;
                this.updateUI();
            });

            const a = document.createElement("a");
            a.setAttribute("href", this.mapsHref(pub));
            a.appendChild(document.createTextNode(pub.name ?? "Unnamed Pub"));

            li.appendChild(input);
            li.appendChild(a);
            li.appendChild(document.createTextNode(` (${distanceStr})`));

            return li;
        };
        const oldUl = elem.getElementsByTagName("ul")[0];
        const newUl = document.createElement("ul");

        const pubs = this.nearbyPubs.toSorted(this.#distanceSort.bind(this));
        const linkElems = pubs.map(createLinkElem);
        for (const elem of linkElems) {
            newUl.appendChild(elem);
        }
        oldUl.replaceWith(newUl);

        elem.style.display = "block";
    }

    distanceStr(meters) {
        let distanceStr = meters.toFixed(0);
        let units = "m";

        if (meters > 1000) {
            distanceStr = (meters / 1000).toFixed(2);
            units = "km";
        }
        return `${distanceStr}${units}`;
    }

    setDistance(meters) {
        this.distanceDiv.innerHTML = this.distanceStr(meters);
        this.distanceDiv.style.display = "block";
    }

    mapsHref(pub) {
        const mapUrl = new URL("https://www.google.com/maps/dir/")
        mapUrl.searchParams.append("api", 1);
        mapUrl.searchParams.append("origin", coordStr(this.currentLocation));
        mapUrl.searchParams.append("destination", coordStr(pub));
        mapUrl.searchParams.append("travelmode", "walking");
        return `${mapUrl}`;
    }

    setName(closestPub) {
        const name = closestPub.name ?? `Unnamed Pub`;
        this.nameDiv.innerHTML = `
            <a href="${this.mapsHref(closestPub)}">${name}</a>
        `;
        this.nameDiv.style.display = "block";
    }

    setStatus(msg, level, fatal = false) {
        if (this.statusPane !== null) {
            for (const statusClass of STATUS_CLASSES) {
                this.statusPane.classList.remove(statusClass);
            }
            this.statusPane.classList.add(level);
            this.statusPane.innerHTML = msg;
            this.statusPane.style.display = "block";
        }
        if (fatal) {
            throw new Error(error);
        }
    }

    clearStatus() {
        this.statusPane.innerHTML = "";
        this.statusPane.style.display = "none";
    }

    dispose() {
        removeEventListener("deviceorientationabsolute", this._onHeading);
        navigator.geolocation.clearWatch(this.watchId);
    }
}

const application = new Application();

