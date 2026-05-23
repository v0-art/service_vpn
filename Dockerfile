# ---------- Stage 1: Frontend build ----------
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: Backend runtime ----------
FROM python:3.11-slim

# Настройка рабочей директории
WORKDIR /app

# Запрещаем Python создавать файлы кэша .pyc и включаем небуферизованный вывод логов
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Установка системных зависимостей (например, curl для проверки работоспособности)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Копируем список зависимостей
COPY requirements.txt .

# Установка зависимостей Python без сохранения кэша
RUN pip install --no-cache-dir -r requirements.txt

# Копируем все файлы проекта в контейнер
COPY . .

# Подкладываем свежесобранный фронтенд в static, чтобы FastAPI отдавал актуальный UI
COPY --from=frontend-builder /frontend/dist ./static

# Создаем папки для логов и постоянных данных (Volume)
RUN mkdir -p logs data

# Открываем порт для FastAPI веб-интерфейса и API
EXPOSE 8080

# Запуск приложения
CMD ["python", "main.py"]
