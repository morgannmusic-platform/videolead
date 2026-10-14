export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS headers pour autoriser ton app web
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // 1. ROUTE UPLOAD : Reçoit les segments vidéo et les stocke dans R2 + D1 (avec gestion du dossier)
            if (path === "/upload" && request.method === "POST") {
                const formData = await request.formData();
                const file = formData.get("file");
                const folder = formData.get("folder") || "Vlogs";

                if (!file) {
                    return new Response(JSON.stringify({ error: "Aucun fichier fourni" }), {
                        status: 400,
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                    });
                }

                const filename = `vlog_${Date.now()}_${Math.random().toString(36).substring(7)}.webm`;
                const size = file.size;
                const now = Date.now();
                const recordedAt = new Date().toISOString();

                // Stockage dans R2
                await env.MY_BUCKET.put(filename, file.stream());

                // Enregistrement dans D1 avec la nouvelle structure (dossier, date exacte, ordre chronologique)
                await env.DB.prepare(
                    "INSERT INTO videos (filename, folder, size, recorded_at, created_at) VALUES (?, ?, ?, ?, ?)"
                ).bind(filename, folder, size, recordedAt, now).run();

                return new Response(JSON.stringify({ success: true, filename, size, folder }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            // 2. ROUTE LISTE : Renvoie toutes les vidéos par ordre chronologique strict (du plus ancien au plus récent, ou inversement)
            if (path === "/videos" && request.method === "GET") {
                const { results } = await env.DB.prepare("SELECT * FROM videos ORDER BY created_at ASC").all();

                return new Response(JSON.stringify(results), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            // 3. ROUTE CREATION DE DOSSIER (Optionnelle si géré en dur ou virtuel, mais trace en base si besoin)
            if (path === "/folder/create" && request.method === "POST") {
                const body = await request.json();
                const folderName = body.folder;

                if (!folderName) {
                    return new Response(JSON.stringify({ error: "Nom de dossier requis" }), {
                        status: 400,
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                    });
                }

                return new Response(JSON.stringify({ success: true, folder: folderName }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            // 4. ROUTE STREAM / TELECHARGEMENT : Permet de lire ou télécharger une vidéo spécifique depuis R2
            if (path.startsWith("/video/") && request.method === "GET") {
                const filename = path.split("/")[2];
                const object = await env.MY_BUCKET.get(filename);

                if (!object) {
                    return new Response("Vidéo introuvable", { status: 404, headers: corsHeaders });
                }

                const headers = new Headers(corsHeaders);
                object.writeHttpMetadata(headers);
                headers.set("etag", object.httpEtag);

                return new Response(object.body, { headers });
            }

            // 5. ROUTE SUPPRESSION : Supprime une vidéo de R2 et de D1
            if (path.startsWith("/delete/") && request.method === "DELETE") {
                const filename = path.split("/")[2];

                await env.MY_BUCKET.delete(filename);
                await env.DB.prepare("DELETE FROM videos WHERE filename = ?").bind(filename).run();

                return new Response(JSON.stringify({ success: true }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            return new Response("Route non trouvée", { status: 404, headers: corsHeaders });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }
    },
};