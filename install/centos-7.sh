#!/bin/bash

echo "Running Hydro Installer for centos 7"
db_password=$(cat /dev/urandom | head -n 10 | md5sum | head -c 20)

# Basic
mkdir -p /etc/yum.repos.d
echo "[mongodb-org-4.4]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/7/mongodb-org/4.4/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://www.mongodb.org/static/pgp/server-4.4.asc" >/etc/yum.repos.d/mongodb-org-4.4.repo
echo "yum install -y mongodb-org"
yum install -y mongodb-org
mkdir -p /var/lib/mongo
mkdir -p /var/log/mongodb
chown -R mongod:mongod /var/lib/mongo /var/log/mongodb

# Install NodeJS
echo "Installing NodeJS"
curl -o- https://cdn.jsdelivr.net/gh/nvm-sh/nvm@v0.36.0/install.sh | sed 's/raw.githubusercontent.com\/nvm-sh\/nvm\//cdn.jsdelivr.net\/gh\/nvm-sh\/nvm@/g' | bash
export NVM_DIR=/root/.nvm
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 14
nvm use 14
npm i yarn -g
echo "Installing pm2"
yarn global add pm2

# Install MongoDB
echo "Installing MongoDB"
echo "db.createUser({
  user: 'hydro',
  pwd: '$db_password',
  roles: [
    { role: 'readWrite', db: 'hydro' }
  ]
})" >/tmp/createUser.js
echo "pm2 start mongod"
pm2 start mongod >/dev/null
sleep 2
mongo 127.0.0.1:27017/hydro /tmp/createUser.js
rm /tmp/createUser.js
echo "pm2 stop mongod"
pm2 stop mongod >/dev/null
pm2 del mongod >/dev/null
echo 'pm2 start "mongod --auth"'
pm2 start "mongod --auth"

# Install Compiler
echo 'Installing g++'
apt-get install -y g++ >/dev/null

# Install HydroOJ
# TODO: install basic addons?
echo "Installing Hydro"
yarn global add hydrooj @hydrooj/ui-default @hydrooj/hydrojudge
wget https://github.com/criyle/go-judge/releases/download/v0.7.1/executorserver-amd64 -O /usr/bin/sandbox
chmod +x /usr/bin/sandbox
pm2 start "/usr/bin/sandbox"
mkdir ~/.hydro
echo "{\"host\":\"127.0.0.1\",\"port\":\"27017\",\"name\":\"hydro\",\"username\":\"hydro\",\"password\":\"$db_password\"}" >~/.hydro/config.json
echo '["@hydrooj/ui-default","@hydrooj/hydrojudge"]' >~/.hydro/addon.json
pm2 start hydrooj

# Done
echo "Done"
echo "Database username: hydro"
echo "Database password: $db_password"
