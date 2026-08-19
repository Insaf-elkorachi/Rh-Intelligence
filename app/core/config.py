from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "SONASID RH Predictive System"
    app_env: str = "development"
    api_prefix: str = "/api/v1"

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db: str = "sonasid_rh"

    upload_dir: str = "data/uploads"

    qdrant_url: str = "http://localhost:6333"
    qdrant_collection_cv: str = "cv_embeddings"
    qdrant_collection_postes: str = "postes_embeddings"

    # Base vectorielle: Chroma est utilisee par defaut car elle tourne en
    # local (mode persistant sur disque) sans serveur externe a installer,
    # ce qui convient a un stage. Le meme service peut etre repointe sur
    # Qdrant plus tard en remplacant VectorStoreService.
    vector_store_dir: str = "data/vector_store"
    vector_collection_cv: str = "cv_embeddings"
    vector_collection_postes: str = "postes_embeddings"

    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    # Authentification reelle (JWT). A changer en production via .env.
    jwt_secret: str = "sonasid-nador-change-moi-en-production"
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 10080  # 7 jours - confortable pour les tests/demo d'un stage

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
