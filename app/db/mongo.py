from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import settings


class Mongo:
    client: AsyncIOMotorClient | None = None


mongo = Mongo()


def get_client() -> AsyncIOMotorClient:
    if mongo.client is None:
        mongo.client = AsyncIOMotorClient(settings.mongodb_uri)
    return mongo.client


def get_database() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongodb_db]


async def close_mongo_connection() -> None:
    if mongo.client is not None:
        mongo.client.close()
        mongo.client = None
