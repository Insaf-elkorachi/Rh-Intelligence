from app.agents.base import BaseAgent


class EmbeddingAgent(BaseAgent):
    name = "embedding_agent"

    def embed_text(self, text: str) -> list[float]:
        # Lightweight deterministic placeholder. Replace with sentence-transformers in production.
        buckets = [0.0] * 32
        for index, char in enumerate(text.lower()):
            buckets[index % len(buckets)] += (ord(char) % 31) / 31
        norm = sum(value * value for value in buckets) ** 0.5 or 1.0
        return [round(value / norm, 6) for value in buckets]
