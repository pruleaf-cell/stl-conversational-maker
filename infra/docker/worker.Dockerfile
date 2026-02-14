FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY apps/api/requirements.txt /app/api-requirements.txt
COPY workers/slicer/requirements.txt /app/worker-requirements.txt
RUN pip install --no-cache-dir -r /app/api-requirements.txt -r /app/worker-requirements.txt

COPY apps/api /app/apps/api
COPY workers/slicer /app/workers/slicer
COPY infra/bambu-profiles /app/infra/bambu-profiles

# Install Bambu Studio CLI in the production image according to platform packaging.
# This base Dockerfile leaves it as a runtime responsibility.

WORKDIR /app/workers/slicer
CMD ["python", "worker.py"]
