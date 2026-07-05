# SMA PV inverter collector (Speedwire).  Build context = apps/collector
FROM python:3.12-slim
WORKDIR /app

# Runtime deps only (no git / anker-solix-api needed for this collector).
COPY requirements-common.txt requirements-sma.txt ./
RUN pip install --no-cache-dir -r requirements-sma.txt

COPY . /app

# Run as a non-root user
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

ENV COLLECTOR=sma
CMD ["python", "collector.py"]
