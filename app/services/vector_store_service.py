"""Base vectorielle (module 2 du cahier des charges).

Utilise ChromaDB en mode persistant (dossier local, aucun serveur externe a
lancer) pour stocker les embeddings des CV et des postes, et permettre la
recherche semantique (matching CV/poste, chatbot RH). Le meme service peut
etre repointe vers Qdrant plus tard (meme interface add_cv/add_job/search)
si un serveur Qdrant dedie est mis en place en production.
"""
from pathlib import Path
from typing import Any

from app.agents.embedding_agent import EmbeddingAgent
from app.core.config import settings

embedding_agent = EmbeddingAgent()


class VectorStoreService:
    def __init__(self) -> None:
        self._client = None
        self._cv_collection = None
        self._postes_collection = None

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        try:
            import chromadb

            Path(settings.vector_store_dir).mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(path=settings.vector_store_dir)
        except Exception:
            # Chroma non installe (pip install chromadb) ou disque non
            # accessible : le systeme reste fonctionnel sans recherche
            # semantique plutot que de planter le reste de l'API.
            self._client = False
        return self._client

    def _collection(self, name: str):
        client = self._ensure_client()
        if not client:
            return None
        return client.get_or_create_collection(name=name)

    def _cv(self):
        if self._cv_collection is None:
            self._cv_collection = self._collection(settings.vector_collection_cv)
        return self._cv_collection

    def _postes(self):
        if self._postes_collection is None:
            self._postes_collection = self._collection(settings.vector_collection_postes)
        return self._postes_collection

    def is_available(self) -> bool:
        return self._ensure_client() is not False

    def upsert_cv_embedding(self, candidate_id: str, text: str, metadata: dict[str, Any]) -> None:
        collection = self._cv()
        if collection is None:
            return
        vector = embedding_agent.embed_text(text)
        collection.upsert(
            ids=[candidate_id],
            embeddings=[vector],
            documents=[text[:2000]],
            metadatas=[{k: str(v) for k, v in metadata.items() if v is not None}],
        )

    def upsert_job_embedding(self, job_id: str, text: str, metadata: dict[str, Any]) -> None:
        collection = self._postes()
        if collection is None:
            return
        vector = embedding_agent.embed_text(text)
        collection.upsert(
            ids=[job_id],
            embeddings=[vector],
            documents=[text[:2000]],
            metadatas=[{k: str(v) for k, v in metadata.items() if v is not None}],
        )

    def search_candidates_for_job(self, query_text: str, top_k: int = 5) -> list[dict[str, Any]]:
        return self._search(self._cv(), query_text, top_k)

    def find_similar_cv(self, text: str, top_k: int = 3) -> list[dict[str, Any]]:
        """Recherche les CV deja indexes les plus proches (checkpoint /
        detection de doublon): un score tres eleve indique un profil deja
        vu ou deja traite."""
        return self._search(self._cv(), text, top_k)

    def search_jobs_for_candidate(self, query_text: str, top_k: int = 5) -> list[dict[str, Any]]:
        return self._search(self._postes(), query_text, top_k)

    def _search(self, collection, query_text: str, top_k: int) -> list[dict[str, Any]]:
        if collection is None:
            return []
        vector = embedding_agent.embed_text(query_text)
        try:
            result = collection.query(query_embeddings=[vector], n_results=top_k)
        except Exception:
            return []
        ids = (result.get("ids") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        metadatas = (result.get("metadatas") or [[]])[0]
        documents = (result.get("documents") or [[]])[0]
        return [
            {
                "id": ids[i],
                "score": round(1 - distances[i], 4) if i < len(distances) else None,
                "metadata": metadatas[i] if i < len(metadatas) else {},
                "excerpt": (documents[i][:200] if i < len(documents) and documents[i] else ""),
            }
            for i in range(len(ids))
        ]


vector_store_service = VectorStoreService()
