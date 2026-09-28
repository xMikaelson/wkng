import Foundation
import Capacitor
import ActivityKit

/// Ponte fra l'app web e la Live Activity del recupero.
/// Dal JavaScript: Capacitor.registerPlugin('AwakeningLive') con i metodi
/// isAvailable(), startRest({...}) ed end(). Vedi awLiveRest in index.html.
@objc(AwakeningLivePlugin)
public class AwakeningLivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AwakeningLivePlugin"
    public let jsName = "AwakeningLive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
        } else {
            call.resolve(["available": false])
        }
    }

    /// Avvia la scheda, o la aggiorna se c'e' gia' (serie successiva,
    /// +tempo, ripresa dopo la pausa).
    @objc func startRest(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["available": false])
            return
        }
        guard let restEndMs = call.getDouble("restEndMs") else {
            call.reject("restEndMs mancante")
            return
        }
        let restStartMs = call.getDouble("restStartMs") ?? (Date().timeIntervalSince1970 * 1000)
        let sessionStartMs = call.getDouble("sessionStartMs") ?? restStartMs
        let state = RestActivityAttributes.ContentState(
            restStart: Date(timeIntervalSince1970: restStartMs / 1000),
            restEnd: Date(timeIntervalSince1970: restEndMs / 1000),
            exerciseName: call.getString("exerciseName") ?? "",
            exerciseIndex: call.getInt("exerciseIndex") ?? 1,
            exerciseCount: call.getInt("exerciseCount") ?? 1,
            nextLabel: call.getString("nextLabel") ?? "",
            setsDone: call.getInt("setsDone") ?? 0,
            setsTotal: call.getInt("setsTotal") ?? 1
        )
        let attributes = RestActivityAttributes(
            sessionName: call.getString("sessionName") ?? "ALLENAMENTO",
            sessionStart: Date(timeIntervalSince1970: sessionStartMs / 1000)
        )
        // staleDate = fine del recupero: da li' la scheda mostra "Tocca a te".
        let content = ActivityContent(state: state, staleDate: state.restEnd)

        Task {
            let running = Activity<RestActivityAttributes>.activities
            // Stessa seduta: si aggiorna la scheda esistente. Seduta diversa
            // (nome o inizio cambiati): si chiude e se ne apre una nuova.
            if let current = running.first,
               current.attributes.sessionName == attributes.sessionName,
               abs(current.attributes.sessionStart.timeIntervalSince(attributes.sessionStart)) < 1 {
                await current.update(content)
                call.resolve(["available": true])
                return
            }
            for old in running { await old.end(nil, dismissalPolicy: .immediate) }
            do {
                _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
                call.resolve(["available": true])
            } catch {
                call.reject("Live Activity non avviata: \(error.localizedDescription)")
            }
        }
    }

    /// Fine dell'allenamento o pausa: la scheda sparisce subito.
    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve()
            return
        }
        Task {
            for activity in Activity<RestActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            call.resolve()
        }
    }
}
