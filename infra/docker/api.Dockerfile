# ZenPDF API + worker image (one image, two commands).
# Build context = backend/ ; see infra/docker-compose.yml.
# Python base is an ARG so the sanctioned python:3.13-slim fallback (arch §2, phase-00 risks)
# is a single override away if an engine wheel is missing on 3.14.
ARG PYTHON_IMAGE=python:3.14-slim

FROM ${PYTHON_IMAGE} AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Runtime deps for the engine stack: OCRmyPDF needs tesseract + ghostscript + unpaper + pngquant.
# LibreOffice is deliberately NOT here — it lives only in the gotenberg container (phase-00 §0.4).
#
# Language packs are eng+heb+deu+fra+spa (phase-06): Hebrew is an acceptance
# criterion, not a nice-to-have — the owner's own documents are RTL. Anything
# else is a build arg rather than a code change, so adding Arabic or Russian is
# `--build-arg OCR_EXTRA_LANGS="tesseract-ocr-ara tesseract-ocr-rus"`.
ARG OCR_EXTRA_LANGS=""
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-heb \
        tesseract-ocr-deu \
        tesseract-ocr-fra \
        tesseract-ocr-spa \
        ${OCR_EXTRA_LANGS} \
        ghostscript \
        unpaper \
        pngquant \
        qpdf \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements/ requirements/

# --- dev target: runserver + dev tooling (also the base image the workers run) ---
FROM base AS dev
RUN pip install -r requirements/dev.txt
# Non-root runtime user (workers must not run as root — arch §12).
RUN useradd --create-home --uid 1000 appuser
COPY . .
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]

# --- prod target: gunicorn ---
FROM base AS prod
RUN pip install -r requirements/prod.txt
RUN useradd --create-home --uid 1000 appuser
COPY . .
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120"]
