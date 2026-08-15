### DEB пакет для создания файла конфигурации Easy-RSA vars

`/part-1/debs/create-config-rsa-vars.sh`

Данный пакет создает файл настроек `vars`. При запуске пакета необходимо указать путь (откуда будет запускаться команда `./easyrsa init-pki`) для сохранения файла, например `/home/yc-user/easy-rsa-ca/vars` (файл сохранится в папку `/home/yc-user/easy-rsa-ca/`)

### Автоматизация создания сети, подсети, виртуальной машины и установка зависимостей firewalld easy-rsa

`/part-1/automation/`

1. Предварительно:
    - Привязать платежный аккаунт Yndex Cloud к облаку
    - Дать необходимые права и назначить роли для пользователя, под которыем будем разворачивать PKI-server
    - На рабочей машине должен быть установлен и настрое Yandex Cloud CLI
    - Сгенерировать публичный и приватный ключ для подключения к виртуальной машине по SSH

2. Отредактировать файл конфигурации `/part-1/automation/config.sh`

    Необходимые настройки:
    - В переменную "CLOUD_NAME" установить имя облака
    - Установить пути до публичного и приватного ключей в переменные "CLOUD_COMPUTER_INSTANCE_KEY" и "CLOUD_COMPUTER_INSTANCE_KEY_SECRET"
    - После выполнения `/part-1/automation/script.sh`, в переменную "CLOUD_COMPUTER_INSTANCE_NETWORK" установить внешний IP адрес виртуальной машины

    Настройки по умолчанию (можно оставить как есть):
    - Имя директории в облаке (директория создается автоматически) - CLOUD_DIR_NAME="server-pki"
    - Имя сети в облаке (сеть создается автоматически) - CLOUD_NETWORK_NAME="network-pki"
    - Имя подсети в облаке (подсеть создается автоматически) - CLOUD_SUB_NETWORK_NAME="sub-network-pki"
    - Зона для подсети - CLOUD_SUB_NETWORK_ZONE="ru-central1-a"
    - Маска подсети - CLOUD_SUB_NETWORK_RANGE="10.128.0.0/24"
    - Имя виртуальной машины (ВМ создается автоматически) - CLOUD_COMPUTER_INSTANCE_NAME="vm-pki"
    - Зона для виртуальной машины, должна совпадать с зоной для сети CLOUD_SUB_NETWORK_ZONE - CLOUD_COMPUTER_INSTANCE_ZONE="ru-central1-a"
    - Пользователь Yandex Cloud, для настройки ВМ (дефолтный в YCloud - "yc-user") - CLOUD_YUSER="yc-user"

3. Запустить файл `/part-1/automation/script.sh`

    После выполнения, в переменную "CLOUD_COMPUTER_INSTANCE_NETWORK" установить внешний IP адрес виртуальной машины

4. Запустить файл `/part-1/automation/script-add-dependencies.sh`
