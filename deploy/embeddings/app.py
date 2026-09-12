import os
from typing import List, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
model = SentenceTransformer(MODEL_NAME)
app = FastAPI(title="Olimpyx local embeddings", version="1.0")

class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: Union[str, List[str]]

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dimension": model.get_sentence_embedding_dimension()}

@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest):
    if request.model and request.model != MODEL_NAME:
        raise HTTPException(status_code=400, detail="Requested model is not loaded")
    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts or any(not text.strip() for text in texts):
        raise HTTPException(status_code=422, detail="input must contain non-empty text")
    vectors = model.encode(texts, normalize_embeddings=True).tolist()
    return {"object": "list", "data": [{"object": "embedding", "index": index, "embedding": vector} for index, vector in enumerate(vectors)], "model": MODEL_NAME}
