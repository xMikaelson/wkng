import ActivityKit
import Foundation

/// Dati della scheda di recupero sulla schermata di blocco e nell'isola
/// dinamica. Questo file appartiene a DUE target: l'app (che avvia e
/// aggiorna la scheda) e l'estensione AwakeningTimer (che la disegna).
@available(iOS 16.2, *)
struct RestActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Inizio e fine del recupero in corso: il conto alla rovescia e la
        /// barra si aggiornano da soli fra queste due date, anche con l'app
        /// sospesa. Alla fine iOS segna la scheda come "stale" e la vista
        /// passa a "Tocca a te".
        var restStart: Date
        var restEnd: Date
        var exerciseName: String
        var exerciseIndex: Int
        var exerciseCount: Int
        /// Carico e ripetizioni della serie che viene dopo, gia' formattati
        /// dall'app ("45,5 kg × 11").
        var nextLabel: String
        var setsDone: Int
        var setsTotal: Int
    }

    /// Nome della seduta ("UPPER B") e ora di inizio, per il tempo trascorso.
    var sessionName: String
    var sessionStart: Date
}
