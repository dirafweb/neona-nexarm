# Prepara Chatwoot para Nexarm: cuenta, persona administradora, bandeja de pruebas y webhook.
# Uso (dentro de Ubuntu): bash conectar-local.sh. Se puede repetir: reutiliza lo que ya existe.
require "json"
require "securerandom"

email = ENV.fetch("CW_ADMIN_EMAIL")
webhook_url = ENV.fetch("CW_WEBHOOK_URL")

account = Account.find_or_create_by!(name: "Neona")
user = User.find_by(email: email)
password = nil
unless user
  password = "#{SecureRandom.alphanumeric(18)}aA1!"
  user = User.new(name: ENV.fetch("CW_ADMIN_NAME", "Gerencia"), email: email, password: password, password_confirmation: password)
  user.skip_confirmation!
  user.save!
end
AccountUser.find_or_create_by!(account: account, user: user) { |au| au.role = :administrator }

inbox = account.inboxes.find_by(name: "Pruebas Nexarm")
unless inbox
  channel = Channel::Api.create!(account: account)
  inbox = Inbox.create!(account: account, channel: channel, name: "Pruebas Nexarm")
end
InboxMember.find_or_create_by!(inbox: inbox, user: user)

webhook = account.webhooks.find_by(url: webhook_url) ||
          account.webhooks.create!(url: webhook_url, subscriptions: ["message_created"])

out = {
  url: ENV.fetch("FRONTEND_URL"), admin_email: email, account_id: account.id, inbox_pruebas: inbox.id,
  token: user.access_token.token, webhook_url: webhook_url, webhook_secret: webhook.try(:secret)
}
out[:admin_password] = password if password
File.write("/tmp/nexarm-conexion.json", JSON.pretty_generate(out))
puts "cuenta=#{account.id} bandeja=#{inbox.id} webhook=#{webhook.id} secreto=#{webhook.try(:secret).present?} clave_nueva=#{!password.nil?}"
