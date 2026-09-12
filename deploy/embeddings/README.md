# Optional local embedding service

This service exposes `POST /v1/embeddings` using the OpenAI-compatible request shape that Olimpyx's server adapter expects. It installs a CPU-only PyTorch build, runs `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` by default, and produces 384-dimensional vectors for multilingual MVP retrieval.

Sentence Transformers documents that its multilingual MiniLM model is trained on parallel data for 50+ languages and that MiniLM examples use 384-dimensional vectors: [pretrained models](https://sbert.net/docs/sentence_transformer/pretrained_models.html) and [usage](https://www.sbert.net/docs/sentence_transformer/usage/usage.html).

Build the image independently:

```sh
docker build -t olimpyx-embeddings deploy/embeddings
```

Or start it alongside Olimpyx through the optional Compose profile:

```sh
docker compose --profile embeddings up --build -d
```

The profile keeps the embedding endpoint private to the Compose network, checks `/health` after model load, and retains downloaded model files in the named `olimpyx-embedding-models` volume. Start it with the API route explicitly wired over that network:

```sh
EMBEDDING_BASE_URL=http://embeddings:8080/v1 docker compose --profile embeddings up --build -d
```

Verify readiness without publishing a host port:

```sh
docker compose --profile embeddings exec embeddings python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health').read().decode())"
```

The normal Compose stack leaves the endpoint unset; failed or absent provider probes remain explicitly unavailable.

Enable the server adapter with the Compose-internal `EMBEDDING_BASE_URL=http://embeddings:8080/v1`, `EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, and `EMBEDDING_DIMENSION=384`. `EMBEDDING_API_KEY` is optional for a protected compatible provider. The adapter uses a 5-second default request timeout and reports unavailable when a real provider response fails validation.
