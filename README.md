# Catan Web

Спільний проєкт 2D вебгри Catan на 3–4 гравців.

## Робота з репозиторієм

Кожну задачу робимо в окремій гілці та відкриваємо pull request у `main`.
Перед злиттям зміни переглядає інший учасник команди.

```sh
git clone https://github.com/ButaFor/catan-web.git
cd catan-web
git switch -c feature/my-task
```

Після внесення змін:

```sh
git add README.md
git commit -m "Describe the change"
git push -u origin feature/my-task
```

Замість `README.md` вказуйте файли своєї задачі.
На GitHub відкрийте **Compare & pull request**, оберіть `main` як базову гілку
та опишіть зміни і спосіб їх перевірки.

Перед наступною задачею:

```sh
git switch main
git pull --ff-only
git switch -c feature/next-task
```

Паролі, ключі та файли `.env` у репозиторій не додаємо.
