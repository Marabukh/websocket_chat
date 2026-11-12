# Участие в разработке

Проект находится на первой рабочей итерации. Предпочитайте небольшие изменения с понятной целью и простым JavaScript без сборки.

Команды выполняются в PowerShell из каталога проекта. После появления репозитория и настройки `origin`:

```powershell
git switch main
git pull --ff-only origin main
git switch -c feature/message-improvement
npm ci
# Внесите изменения и проверьте интерфейс в двух окнах.
npm test
git diff
# Указывайте только действительно изменённые файлы:
git add public/client.js test/chat.test.js
git commit -m "Improve chat message handling"
git push -u origin feature/message-improvement
```

Откройте Pull Request на GitHub в `main`. Опишите проблему, результат и фактически выполненные проверки. После проверки и слияния обновите локальную ветку:

```powershell
git switch main
git pull --ff-only origin main
```

Для следующего изменения создайте новую ветку с другим именем. Не включайте в коммит `node_modules`, секреты или посторонние локальные файлы. `package-lock.json` сохраняйте в Git при изменении зависимостей. Проверяйте `git status` и `git diff --cached` перед коммитом. Изменения протокола сопровождайте обновлением README и интеграционных тестов.
