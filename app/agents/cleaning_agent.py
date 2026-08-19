import pandas as pd

from app.agents.base import BaseAgent


class CleaningAgent(BaseAgent):
    name = "cleaning_agent"

    def clean_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df.columns = [
            str(column).strip().lower().replace(" ", "_").replace("-", "_")
            for column in df.columns
        ]
        df = df.dropna(how="all")
        df = df.drop_duplicates()

        for column in df.select_dtypes(include=["object"]).columns:
            df[column] = df[column].astype(str).str.strip()
            df[column] = df[column].replace({"nan": None, "NaT": None, "": None})

        return df
