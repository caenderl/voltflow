# Build-Context = apps/collector
FROM python:3.12-slim
WORKDIR /app

# git wird für die pip-Installation der anker-solix-api von GitHub benötigt
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Laufzeit-Abhängigkeiten: asyncpg + dotenv (requirements) und die
# anker-solix-api direkt von GitHub (zieht aiohttp/cryptography/paho-mqtt mit).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir git+https://github.com/thomluther/anker-solix-api.git

COPY . /app

CMD ["python", "collector.py"]
