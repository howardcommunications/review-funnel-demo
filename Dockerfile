FROM node:24-alpine
WORKDIR /app
COPY . /app
ENV PORT=7860
ENV TWILIO_MODE=mock
EXPOSE 7860
CMD ["node", "server.js"]
